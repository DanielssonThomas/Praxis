import { createHash, randomUUID } from "node:crypto";
import { sessionIdSchema } from "@praxis/contracts";
import type { SessionId } from "@praxis/contracts";
import { HermesRuntimeError, manualGuidanceSchema } from "@praxis/hermes-runtime";
import type { HermesAssignment, HermesRuntime } from "@praxis/hermes-runtime";
import type { OperationalStore, SessionControlState } from "@praxis/state";
import { z } from "zod";

const session = { sessionId: sessionIdSchema };
const commands = z.discriminatedUnion("operation", [
  z.strictObject({ ...session, operation: z.literal("takeover") }),
  z.strictObject({ ...session, operation: z.literal("guide"), text: manualGuidanceSchema }),
  z.strictObject({ ...session, operation: z.literal("return") }),
]);
type ManualState = Extract<SessionControlState, { mode: "manual" }>;
type NativeProof = "delivered" | "recorded";
type ControlRuntime = Pick<HermesRuntime, "guidanceReady" | "guidanceBaseline" | "steerAssignment" | "reconcileGuidance">;
type LoadControlBinding = (id: SessionId) => Promise<ControlBinding | undefined>;

export interface ControlBinding {
  assignment: HermesAssignment;
  enabled: boolean;
}
export interface SessionControlView {
  mode: "read_only" | "manual" | "automated_write";
  canTakeover: boolean;
  canGuide: boolean;
  canReturn: boolean;
  guidance: "none" | "pending" | "uncertain" | NativeProof;
}

export class SessionControlError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function bindingDigest({ assignment }: ControlBinding): string {
  return digest(JSON.stringify([assignment.taskId, assignment.sessionId, assignment.runId]));
}

export class SessionControlService {
  readonly #store: OperationalStore;
  readonly #runtime: ControlRuntime;
  readonly #loadBinding: LoadControlBinding;

  constructor(options: {
    store: OperationalStore;
    runtime: ControlRuntime;
    loadBinding: LoadControlBinding;
  }) {
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#loadBinding = options.loadBinding;
  }

  view(binding: ControlBinding, running: boolean): SessionControlView {
    const state = this.#store.sessionControl(binding.assignment.sessionId);
    if (state?.mode === "manual") {
      const inScope = state.assignmentDigest === bindingDigest(binding);
      return {
        mode: "manual", canTakeover: false, canGuide: inScope && binding.enabled && running, canReturn: inScope,
        guidance: state.pending === undefined ? "none" : state.pending.outcome === "accepted" ? "pending" : "uncertain",
      };
    }
    return {
      mode: state?.mode ?? "read_only", canTakeover: state === undefined && binding.enabled && running,
      canGuide: false, canReturn: false, guidance: "none",
    };
  }

  async operate(value: unknown): Promise<SessionControlView> {
    const parsed = commands.safeParse(value);
    if (!parsed.success) throw new SessionControlError(400, "Choose an exact session and a valid control command.");
    const command = parsed.data;
    const binding = await this.#loadBinding(command.sessionId);
    if (binding === undefined) throw new SessionControlError(404, "The native session is outside local control scope.");
    const { assignment } = binding;
    const identity = bindingDigest(binding);
    const state = this.#store.sessionControl(command.sessionId);
    if (command.operation !== "return" && !binding.enabled) {
      throw new SessionControlError(403, "Manual guidance is disabled for this session.");
    }
    if (state?.mode === "automated_write") {
      throw new SessionControlError(409, "A scoped session action owns control or has an unresolved native outcome.");
    }

    if (command.operation === "takeover") {
      if (state !== undefined) throw new SessionControlError(409, "This session is already under manual control.");
      if (!await this.#runtime.guidanceReady(assignment)) {
        throw new SessionControlError(409, "Hermes is not accepting manual guidance for this run.");
      }
      await this.#requireBinding(command.sessionId, identity, true);
      this.#replace(command.sessionId, undefined, { mode: "manual", revision: randomUUID(), assignmentDigest: identity });
      return this.view(binding, true);
    }
    if (state?.mode !== "manual" || state.assignmentDigest !== identity) {
      throw new SessionControlError(409, "Take over this exact native session before sending guidance or returning control.");
    }

    const proof = await this.#reconcile(assignment, state);
    if (command.operation === "return") {
      await this.#requireBinding(command.sessionId, identity, false);
      this.#replace(command.sessionId, state.revision, undefined);
      return { ...this.view(binding, false), guidance: proof ?? "none" };
    }

    const afterMessageId = await this.#runtime.guidanceBaseline(assignment);
    const pending = { afterMessageId, textDigest: digest(command.text), outcome: "submitting" as const };
    const claim = { ...state, revision: randomUUID(), pending };
    this.#replace(command.sessionId, state.revision, claim);
    let dispatched = false;
    try {
      await this.#runtime.steerAssignment(assignment, command.text, async () => {
        await this.#requireBinding(command.sessionId, identity, true);
        if (this.#store.sessionControl(command.sessionId)?.revision !== claim.revision) this.#conflict();
        dispatched = true;
      });
    } catch (error) {
      const refused = error instanceof HermesRuntimeError && ["native_refused", "unauthorized", "not_found"].includes(error.code);
      const ambiguous = dispatched && !refused;
      this.#store.compareSessionControl(command.sessionId, claim.revision, {
        ...state, revision: randomUUID(), pending: ambiguous ? { ...pending, outcome: "uncertain" } : undefined,
      });
      if (ambiguous) throw new SessionControlError(409, "The native guidance outcome is uncertain. Confirm it in Hermes before sending again or returning control.");
      throw error;
    }
    this.#store.compareSessionControl(command.sessionId, claim.revision, {
      ...claim, revision: randomUUID(), pending: { ...pending, outcome: "accepted" },
    });
    return this.view(binding, true);
  }

  async #requireBinding(id: SessionId, identity: string, needsGuidance: boolean): Promise<void> {
    const binding = await this.#loadBinding(id);
    if (binding === undefined || bindingDigest(binding) !== identity || (needsGuidance && !binding.enabled)) {
      throw new SessionControlError(403, "The native assignment or manual guidance permission changed.");
    }
  }

  async #reconcile(assignment: HermesAssignment, state: ManualState): Promise<NativeProof | undefined> {
    if (state.pending === undefined) return;
    const { afterMessageId, textDigest } = state.pending;
    const proof = await this.#runtime.reconcileGuidance(assignment, afterMessageId, textDigest);
    if (proof === undefined) {
      throw new SessionControlError(409, "Hermes has yet to expose this guidance in the native transcript. Manual control remains active.");
    }
    return proof;
  }

  #replace(id: SessionId, revision: string | undefined, state: SessionControlState | undefined): void {
    if (!this.#store.compareSessionControl(id, revision, state)) this.#conflict();
  }

  #conflict(): never {
    throw new SessionControlError(409, "Session control changed. Refresh the session and try again.");
  }
}
