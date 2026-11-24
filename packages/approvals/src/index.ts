import { createHash, randomUUID } from "node:crypto";
import {
  approvalIdSchema,
  approvalSchema,
  contractVersion,
  eventIdSchema,
  eventSchema,
  runtimeSessionSnapshotSchema,
} from "@praxis/contracts";
import type { Action, ActionLifecycle, Approval, Event, EventId, RuntimeSessionSnapshot } from "@praxis/contracts";
import { HermesRuntimeError } from "@praxis/hermes-runtime";
import type { HermesAssignment, HermesRuntime } from "@praxis/hermes-runtime";
import { mcpGrantsSchema } from "@praxis/mcp";
import type { McpGrant } from "@praxis/mcp";
import { OperationalStoreError } from "@praxis/state";
import type { OperationalStore } from "@praxis/state";
import { z } from "zod";

type RequestDetails = Extract<Event["details"], { type: "action_request" }>;
type ActionRequest = { requestId: EventId; action: Action; actorId: RequestDetails["actorId"] };
type Stages = { [Transition in ActionLifecycle as Transition["stage"]]: Transition["value"] };
type Stage = keyof Stages;
type StageValue<S extends Stage> = Stages[S];
type Evaluation = StageValue<"evaluation">;
type ActiveEvaluation = Exclude<Evaluation, { mode: "refused" }>;
type Decision = StageValue<"decision">;
type ExecutionDecision = Extract<Decision, { kind: "approve" | "routine" }>;
type Settlement = StageValue<"settlement">;
type Binding = { assignment: HermesAssignment; scopeDigest: string };

export type ApprovalActivity = ActionRequest & (
  | { state: "processing" }
  | { state: "attention"; approval: Approval; expiresAt: string }
  | { state: "resolved"; native: RuntimeSessionSnapshot }
  | { state: "denied" }
  | { state: "expired" | "invalidated" | "refused" | "uncertain"; reason: string }
);

type ApprovalErrorCode = "invalid_input" | "not_found" | "invalid_approval" | "already_decided" | "expired"
  | "invalidated" | "control_busy";
export class ApprovalError extends Error {
  constructor(readonly code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

const decisionInput = z.strictObject({
  requestId: eventIdSchema,
  approvalId: approvalIdSchema,
  decision: z.enum(["approve", "deny"]),
});
const approvalLifetimeMs = 5 * 60 * 1_000;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stageId(action: Action, stage: Stage): string {
  return `event_${digest([action.id, stage])}`;
}

function readRequest(event: Event | undefined): ActionRequest {
  if (event?.details?.type !== "action_request" || event.kind !== "action.requested") {
    throw new ApprovalError("not_found", "The requested activity is unavailable.");
  }
  const { action, actorId } = event.details;
  return { requestId: event.id, action, actorId };
}

function isConflict(error: unknown): boolean {
  return error instanceof OperationalStoreError && error.code === "identity_conflict";
}

export class ApprovalService {
  readonly #store: OperationalStore;
  readonly #loadGrants: () => Promise<unknown>;
  readonly #runtime: Pick<HermesRuntime, "inspectAssignment" | "stopAssignment">;
  readonly #now: () => number;
  readonly #inFlight = new Set<string>();

  constructor(options: {
    store: OperationalStore;
    loadGrants: () => Promise<unknown>;
    runtime: Pick<HermesRuntime, "inspectAssignment" | "stopAssignment">;
    now?: () => number;
  }) {
    this.#store = options.store;
    this.#loadGrants = options.loadGrants;
    this.#runtime = options.runtime;
    this.#now = options.now ?? Date.now;
  }

  async list(): Promise<ApprovalActivity[]> {
    const grants = await this.#grants();
    return this.#store.eventsOfKind("action.requested")
      .filter((event) => event.details?.type === "action_request")
      .map((event) => this.#activity(readRequest(event), grants));
  }

  async advanceRoutine(): Promise<void> {
    let remaining = 8;
    for (const event of this.#store.eventsOfKind("action.requested")) {
      if (event.details?.type !== "action_request" || event.details.action.kind !== "session.inspect") continue;
      const request = readRequest(event);
      if (this.#readStage(request, "decision") !== undefined || this.#readStage(request, "evaluation")?.mode === "refused") continue;
      await this.inspect(request.requestId);
      remaining -= 1;
      if (remaining === 0) break;
    }
  }

  async inspect(requestId: unknown): Promise<ApprovalActivity> {
    const id = eventIdSchema.safeParse(requestId);
    if (!id.success) throw new ApprovalError("invalid_input", "Supply a valid action request ID.");
    const request = readRequest(this.#store.getEvent(id.data));
    const grants = await this.#grants();
    const review = this.#readStage(request, "evaluation") ?? this.#evaluate(request, grants);
    if (review.mode === "routine" && this.#readStage(request, "decision") === undefined) {
      try {
        await this.#execute(request, review, { kind: "routine", scopeDigest: review.scopeDigest });
      } catch (error) {
        if (!(error instanceof ApprovalError && error.code === "already_decided")) throw error;
      }
    }
    return this.#activity(request, await this.#grants());
  }

  async decide(input: unknown): Promise<ApprovalActivity> {
    const parsed = decisionInput.safeParse(input);
    if (!parsed.success) throw new ApprovalError("invalid_input", "Supply an exact request, approval and decision.");
    const request = readRequest(this.#store.getEvent(parsed.data.requestId));
    const prior = this.#readStage(request, "decision");
    if (prior?.kind === "expired" || prior?.kind === "invalidated") {
      throw new ApprovalError(prior.kind, prior.reason);
    }
    if (prior !== undefined) {
      throw new ApprovalError("already_decided", "This activity already has a decision.");
    }
    const review = this.#readStage(request, "evaluation");
    if (review?.mode !== "approval" || review.approval.id !== parsed.data.approvalId
      || review.approval.actionId !== request.action.id) {
      throw new ApprovalError("invalid_approval", "This approval does not match the exact action.");
    }

    const decision = { scopeDigest: review.scopeDigest, approvalId: review.approval.id };
    const grants = await this.#grants();
    if (parsed.data.decision === "deny") {
      this.#claim(request, { ...decision, kind: "deny" });
    } else {
      try {
        this.#requireBinding(request, review, grants);
      } catch (error) {
        this.#invalidate(request, review, error);
        throw error;
      }
      await this.#execute(request, review, { ...decision, kind: "approve" });
    }
    return this.#activity(request, await this.#grants());
  }

  async #grants(): Promise<McpGrant[]> {
    return mcpGrantsSchema.parse(await this.#loadGrants());
  }

  #binding({ action, actorId }: ActionRequest, grants: McpGrant[]): Binding | undefined {
    if (action.target.kind !== "session" || (action.kind !== "session.inspect" && action.kind !== "session.stop")) return;
    const { id } = action.target;
    const grant = grants.find((entry) => entry.principalId === actorId && entry.actionKinds.includes(action.kind));
    if (grant === undefined) return;
    const assignment = grant.sessions.find((entry) => entry.sessionId === id)?.assignment;
    const session = this.#store.getSession(id);
    if (assignment === undefined || session === undefined
      || assignment.sessionId !== session.id || assignment.taskId !== session.taskId) return;
    return { assignment, scopeDigest: digest({ actorId, action, grant, assignment }) };
  }

  #evaluate(request: ActionRequest, grants: McpGrant[]): Evaluation {
    const binding = this.#binding(request, grants);
    let value: Evaluation;
    if (binding === undefined) {
      value = { mode: "refused", reason: "No trusted runtime scope authorizes this action and target." };
    } else if (request.action.kind === "session.inspect") {
      value = { mode: "routine", scopeDigest: binding.scopeDigest };
    } else {
      value = {
        mode: "approval",
        scopeDigest: binding.scopeDigest,
        approval: approvalSchema.parse({
          schemaVersion: contractVersion,
          id: `approval_${digest(request.action.id)}`,
          actionId: request.action.id,
        }),
        expiresAt: new Date(this.#now() + approvalLifetimeMs).toISOString(),
      };
    }
    try {
      this.#writeStage(request, { stage: "evaluation", value });
    } catch (error) {
      const concurrent = isConflict(error) ? this.#readStage(request, "evaluation") : undefined;
      if (concurrent !== undefined) return concurrent;
      throw error;
    }
    return value;
  }

  #requireBinding(request: ActionRequest, review: ActiveEvaluation, grants: McpGrant[]): Binding {
    if (review.mode === "approval" && this.#now() >= Date.parse(review.expiresAt)) {
      throw new ApprovalError("expired", "This approval expired. A new action request is required.");
    }
    const binding = this.#binding(request, grants);
    if (binding?.scopeDigest !== review.scopeDigest) {
      throw new ApprovalError("invalidated", "The actor grant or native assignment changed. A new request is required.");
    }
    return binding;
  }

  #claim(request: ActionRequest, value: Decision, revision?: string): void {
    try {
      const transition: ActionLifecycle = { stage: "decision", value };
      if (revision === undefined) {
        if (this.#writeStage(request, transition) === "inserted") return;
      } else {
        const { id: sessionId } = request.action.target;
        if (this.#store.compareSessionControl(sessionId, undefined, {
          mode: "automated_write", revision, actionId: request.action.id,
        }, this.#stageEvent(request, transition))) return;
        const owner = this.#store.sessionControl(sessionId);
        if ((owner?.mode !== "automated_write" || owner.actionId !== request.action.id)
          && this.#readStage(request, "decision") === undefined) {
          throw new ApprovalError("control_busy", "Session control holds this action. Wait for control to return before approving it.");
        }
      }
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
    throw new ApprovalError("already_decided", "This activity already has a decision.");
  }

  #invalidate(request: ActionRequest, review: ActiveEvaluation, error: unknown): void {
    if (!(error instanceof ApprovalError) || (error.code !== "expired" && error.code !== "invalidated")) return;
    try {
      this.#claim(request, { kind: error.code, reason: error.message, scopeDigest: review.scopeDigest });
    } catch (conflict) {
      if (!(conflict instanceof ApprovalError && conflict.code === "already_decided")) throw conflict;
    }
  }

  async #execute(request: ActionRequest, review: ActiveEvaluation, decision: ExecutionDecision): Promise<void> {
    const routine = request.action.kind === "session.inspect" && review.mode === "routine" && decision.kind === "routine";
    const approved = request.action.kind === "session.stop" && review.mode === "approval" && decision.kind === "approve"
      && review.approval.actionId === request.action.id && review.approval.id === decision.approvalId;
    if (!routine && !approved) throw new ApprovalError("invalid_approval", "The decision does not authorize this exact action.");
    const { id: sessionId } = request.action.target;
    const revision = approved ? randomUUID() : undefined;
    this.#claim(request, decision, revision);
    this.#inFlight.add(request.action.id);
    let mayHaveDispatched = false;
    try {
      let result: Settlement;
      try {
        const binding = this.#requireBinding(request, review, await this.#grants());
        const native = runtimeSessionSnapshotSchema.parse(routine
          ? await this.#runtime.inspectAssignment(binding.assignment)
          : await this.#runtime.stopAssignment(binding.assignment, async () => {
            this.#requireBinding(request, review, await this.#grants());
            mayHaveDispatched = true;
          }));
        if (native.taskId !== binding.assignment.taskId || native.sessionId !== binding.assignment.sessionId) {
          throw new Error("The native receipt identified another assignment");
        }
        result = { outcome: "resolved", native };
      } catch (error) {
        const refused = error instanceof HermesRuntimeError
          && ["native_refused", "unauthorized", "not_found", "unsupported"].includes(error.code);
        result = error instanceof ApprovalError || refused
          ? { outcome: "invalidated", reason: error.message }
          : { outcome: "uncertain", reason: "The native execution outcome could not be verified. The claim cannot be retried." };
      }
      const settlement: ActionLifecycle = { stage: "settlement", value: result };
      if (revision === undefined || (mayHaveDispatched && result.outcome === "uncertain")) {
        this.#writeStage(request, settlement);
      } else if (!this.#store.compareSessionControl(sessionId, revision, undefined, this.#stageEvent(request, settlement))) {
        throw new Error("The scoped execution lost its durable session control.");
      }
    } finally {
      this.#inFlight.delete(request.action.id);
    }
  }

  #activity(request: ActionRequest, grants: McpGrant[]): ApprovalActivity {
    const settlement = this.#readStage(request, "settlement");
    if (settlement?.outcome === "resolved") return { ...request, state: "resolved", native: settlement.native };
    if (settlement !== undefined) return { ...request, state: settlement.outcome, reason: settlement.reason };

    const decision = this.#readStage(request, "decision");
    if (decision?.kind === "deny") return { ...request, state: "denied" };
    if (decision?.kind === "expired" || decision?.kind === "invalidated") {
      return { ...request, state: decision.kind, reason: decision.reason };
    }
    if (decision !== undefined && !this.#inFlight.has(request.action.id)) {
      return { ...request, state: "uncertain", reason: "A durable claim exists without a native receipt. The action cannot be retried." };
    }

    const evaluation = this.#readStage(request, "evaluation");
    if (decision !== undefined || evaluation === undefined || evaluation.mode === "routine") {
      return { ...request, state: "processing" };
    }
    if (evaluation.mode === "refused") return { ...request, state: "refused", reason: evaluation.reason };

    try {
      this.#requireBinding(request, evaluation, grants);
    } catch (error) {
      if (error instanceof ApprovalError && (error.code === "expired" || error.code === "invalidated")) {
        this.#invalidate(request, evaluation, error);
        return this.#activity(request, grants);
      }
      throw error;
    }
    return { ...request, state: "attention", approval: evaluation.approval, expiresAt: evaluation.expiresAt };
  }

  #readStage<S extends Stage>(request: ActionRequest, stage: S): StageValue<S> | undefined {
    const event = this.#store.getEvent(stageId(request.action, stage));
    if (event === undefined) return;
    const details = event.details;
    if (details?.type !== "action_lifecycle" || details.requestId !== request.requestId
      || details.actionId !== request.action.id || details.transition.stage !== stage) {
      throw new Error("The activity journal does not match the exact request.");
    }
    return details.transition.value as StageValue<S>;
  }

  #writeStage(request: ActionRequest, transition: ActionLifecycle) {
    return this.#store.appendEvent(this.#stageEvent(request, transition));
  }

  #stageEvent(request: ActionRequest, transition: ActionLifecycle): Event {
    return eventSchema.parse({
      schemaVersion: contractVersion,
      id: stageId(request.action, transition.stage),
      occurredAt: new Date(this.#now()).toISOString(),
      kind: `action.${transition.stage}`,
      subject: { kind: "action", id: request.action.id },
      details: { type: "action_lifecycle", requestId: request.requestId, actionId: request.action.id, transition },
    });
  }
}
