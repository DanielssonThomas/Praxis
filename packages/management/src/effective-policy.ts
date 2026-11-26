import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import {
  contractVersion, eventIdSchema, eventSchema, principalIdSchema, runtimeSessionSnapshotSchema, usageSchema,
  workerAssignmentRequestSchema, workerAssignmentSchema,
} from "@praxis/contracts";
import type { Event, EventId, SessionId, TaskId, WorkerAssignment, WorkerAssignmentRequest, WorkerObservation } from "@praxis/contracts";
import { mcpGrantsSchema } from "@praxis/mcp";
import { OperationalStoreError } from "@praxis/state";
import type { OperationalStore } from "@praxis/state";
import { axiomRevision, loadPolicyAxiom } from "./effective-policy-axiom.js";
import type { PolicyAxiom, VerificationReport, VerificationRun, VerifyOptions } from "./effective-policy-axiom.js";

export interface EffectiveTaskAuthority {
  revision: number;
  root: string;
  brief: unknown;
  requirements: readonly unknown[];
  protectedPaths: readonly string[];
  verificationHost: unknown;
  reviewerId: string;
}

interface Options {
  store: OperationalStore;
  loadGrants(): Promise<unknown>;
  loadAuthority(taskId: TaskId): Promise<EffectiveTaskAuthority | undefined>;
}

interface IntegrationResult {
  admissionId: string;
  assignment: WorkerAssignment;
  observation: WorkerObservation;
}

interface Completion extends IntegrationResult {
  review: { reviewerId: string; sourceDigest: string; receiptDigest: string };
  verification: VerificationRun;
}

type Details = Extract<NonNullable<Event["details"]>, { type: `policy_${string}` }>;
type AuthorityDetails = Extract<Details, { type: "policy_authority" }>;
type Write = "inserted" | "duplicate";
type ErrorCode = "invalid_input" | "forbidden" | "not_found" | "authority_conflict" | "stale" | "unavailable";

export class EffectivePolicyError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EffectivePolicyError";
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function eventId(kind: string, key: unknown): EventId {
  return eventIdSchema.parse(`event_policy_${kind}_${digest(key).slice(7)}`);
}

function policyEvent(id: EventId, kind: string, taskId: TaskId, details: Details): Event {
  return eventSchema.parse({ schemaVersion: contractVersion, id, kind, occurredAt: new Date().toISOString(), subject: { kind: "task", id: taskId }, details });
}

function portablePath(path: unknown): path is string {
  return typeof path === "string" && !/[:\\\x00-\x1f]/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function overlaps(left: string, right: string): boolean {
  if (process.platform === "win32") return overlapsPortable(left.toLowerCase(), right.toLowerCase());
  return overlapsPortable(left, right);
}

function overlapsPortable(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function within(parent: string, path: string): boolean {
  const offset = relative(parent, path);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

function commandPaths(plan: VerificationRun["plan"]): string[] {
  return [...new Set(plan.checks.flatMap(({ sources }) => sources.map(({ path }) => path)))];
}

/** Local host boundary. Only compose this service with operator-owned authority and verification. */
export class EffectivePolicyService {
  static async open(options: Options & { axiomRoot: string; evidenceRoot: string }): Promise<EffectivePolicyService> {
    try {
      return new EffectivePolicyService(options, await loadPolicyAxiom(options.axiomRoot, options.evidenceRoot));
    } catch (cause) {
      throw new EffectivePolicyError("unavailable", "The governing Axiom build or trusted evidence archive is unavailable.", { cause });
    }
  }

  constructor(private readonly options: Options, private readonly axiom: PolicyAxiom) {}

  async preview(requestId: string, sessionId: string): Promise<{ fingerprint: string; request: WorkerAssignmentRequest }> {
    const { fingerprint, request, plan } = await this.#prepare(requestId, sessionId);
    return { fingerprint: digest([fingerprint, await this.#source(plan)]), request };
  }

  async admit(requestId: string, sessionId: string, expectedFingerprint: string) {
    const prepared = await this.#prepare(requestId, sessionId);
    const { request, fingerprint, version } = prepared;
    const source = await this.#source(prepared.plan);
    if (digest([fingerprint, source]) !== expectedFingerprint) throw new EffectivePolicyError("stale", "The exact approved delegation scope changed.");
    const admissionId = eventId("admission", requestId);
    if (this.options.store.getEvent(eventId("completion", request.task.id)) && !this.options.store.getEvent(admissionId)) {
      throw new EffectivePolicyError("stale", "The task already has a conforming completion.");
    }
    this.#write(policyEvent(eventId("authority", [request.task.id, version.revision]), "task.policy_authorized", request.task.id, version));
    const write = this.#write(policyEvent(admissionId, "task.delegation_admitted", request.task.id, {
      type: "policy_admission", requestId: eventIdSchema.parse(requestId), sessionId: request.session.id, revision: version.revision,
      fingerprint, sourceDigest: source.digest,
    }));
    return { admissionId, request, write, source };
  }

  async recordLaunch(admissionId: string, value: unknown): Promise<Write> {
    const { admission, request } = await this.#current(admissionId);
    const assignment = this.#assignment(request.task.id, request.session.id, value);
    return this.#write(policyEvent(eventId("launch", admission.id), "task.delegation_launched", request.task.id, {
      type: "policy_launch", admissionId: admission.id, assignment,
    }));
  }

  /** Run admitted checks only from the trusted, isolated verification process. */
  async verify(admissionId: string, options: VerifyOptions = {}): Promise<VerificationRun> {
    const { plan, host, admission } = await this.#current(admissionId);
    if (this.options.store.getEvent(eventId("launch", admission.id))?.details?.type !== "policy_launch") {
      throw new EffectivePolicyError("invalid_input", "Record the admitted native launch before acceptance verification.");
    }
    return this.axiom.verify(plan, host, options);
  }

  async inspectIntegration(input: IntegrationResult) {
    const current = await this.#current(input.admissionId);
    const assignment = this.#assignment(current.request.task.id, current.request.session.id, input.assignment);
    const launch = this.options.store.getEvent(eventId("launch", current.admission.id))?.details;
    if (launch?.type !== "policy_launch" || digest(launch.assignment) !== digest(assignment)) {
      throw new EffectivePolicyError("invalid_input", "The native result must match the recorded launch.");
    }
    const snapshot = runtimeSessionSnapshotSchema.safeParse(input.observation?.snapshot);
    const usage = usageSchema.safeParse(input.observation?.usage);
    if (!snapshot.success || snapshot.data.taskId !== assignment.taskId || snapshot.data.sessionId !== assignment.sessionId
      || snapshot.data.status !== "completed" || !usage.success || usage.data.sessionId !== assignment.sessionId) {
      throw new EffectivePolicyError("invalid_input", "The exact native worker must have a settled completed observation.");
    }
    const source = await this.#source(current.plan);
    return { source, receiptDigest: digest([assignment, snapshot.data, usage.data]) };
  }

  async complete(input: Completion): Promise<{ verification: VerificationReport; write?: Write }> {
    const current = await this.#current(input.admissionId);
    if (input.review?.reviewerId !== current.reviewerId) {
      throw new EffectivePolicyError("forbidden", "The integrated result requires its authorized reviewer.");
    }
    const integrated = await this.inspectIntegration(input);
    if (input.review.sourceDigest !== integrated.source.digest || input.review.receiptDigest !== integrated.receiptDigest) {
      throw new EffectivePolicyError("stale", "The integrated source or settled worker result changed after review.");
    }
    const run = input.verification;
    if (!run || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(run.id) || digest(run.host ?? null) !== digest(current.host)
      || digest(run.plan ?? null) !== current.version.planDigest || !Array.isArray(run.report?.checks)) {
      throw new EffectivePolicyError("stale", "The evidence must come from the approved verification plan and host.");
    }
    const assessed = await this.axiom.assess({ ...run, plan: current.plan, host: current.host });
    const launchedAt = this.options.store.getEvent(eventId("launch", current.admission.id))!.occurredAt;
    const checks = await Promise.all(assessed.checks.map(async (check) => {
      if (!check.required || check.outcome.status !== "passed") return check;
      const observedAt = check.evidenceId && await this.axiom.evidenceStartedAt(check.evidenceId).catch(() => undefined);
      if (observedAt && Date.parse(observedAt) >= Date.parse(launchedAt)) return check;
      return { ...check, outcome: { status: "blocked", reason: "Observed evidence must be fresh for the admitted native run." } };
    }));
    const conforms = assessed.conforms && checks.every((check) => !check.required || check.outcome.status === "passed");
    const verification = { conforms, checks };
    if (!conforms) return { verification };

    const final = await this.#current(input.admissionId);
    const source = await this.#source(final.plan);
    if (source.digest !== integrated.source.digest) throw new EffectivePolicyError("stale", "The integrated source changed during completion.");
    const taskId = final.request.task.id;
    const write = this.#write(policyEvent(eventId("completion", taskId), "task.completed", taskId, {
      type: "policy_completion", admissionId: final.admission.id, reviewerId: final.reviewerId,
      sourceDigest: integrated.source.digest, receiptDigest: integrated.receiptDigest,
      sourceRevision: source.revision,
      runId: input.assignment.runId, verificationRunId: run.id,
    }));
    return { verification, write };
  }

  async #prepare(requestId: string, sessionId: string) {
    const { store } = this.options;
    const intent = store.getEvent(requestId);
    if (intent?.kind !== "action.requested" || intent.details?.type !== "action_request"
      || intent.details.action.kind !== "task.delegate" || intent.subject.kind !== "task") {
      throw new EffectivePolicyError("not_found", "An exact scoped task delegation request is required.");
    }
    const taskId = intent.subject.id;
    const task = store.getTask(taskId);
    const session = store.getSession(sessionId);
    if (task === undefined || session?.taskId !== taskId) {
      throw new EffectivePolicyError("invalid_input", "The destination session must belong to the delegated task.");
    }
    const { actorId } = intent.details;
    const grant = mcpGrantsSchema.parse(await this.options.loadGrants()).find(({ principalId, taskIds, actionKinds }) =>
      principalId === actorId && taskIds.includes(taskId) && actionKinds.includes("task.delegate"));
    if (!grant) throw new EffectivePolicyError("forbidden", "The requesting principal lacks current delegation scope.");
    const authority = await this.options.loadAuthority(taskId);
    if (!authority) throw new EffectivePolicyError("forbidden", "No operator-owned assignment authority covers this task.");
    const { revision, requirements, protectedPaths } = authority;
    if (!Number.isSafeInteger(revision) || revision < 1 || !isAbsolute(authority.root) || !Array.isArray(requirements)
      || !Array.isArray(protectedPaths) || !protectedPaths.every(portablePath)) {
      throw new EffectivePolicyError("invalid_input", "Supply versioned authority with an absolute root and literal protected paths.");
    }
    const brief = this.axiom.parseBrief(authority.brief);
    const host = this.axiom.parseHost(authority.verificationHost);
    const reviewerId = principalIdSchema.parse(authority.reviewerId);
    if (brief.id !== taskId || !brief.ownedPaths.every(portablePath)) {
      throw new EffectivePolicyError("invalid_input", "The canonical brief must bind the task and a literal owned scope.");
    }
    if (digest(brief.policy) !== digest(this.axiom.policy())) {
      throw new EffectivePolicyError("forbidden", "The brief does not select the qualified, governing Axiom policy.");
    }
    const plan = await this.axiom.plan({ root: authority.root, task: brief, requirements });
    if (this.axiom.evidenceRoot && (within(plan.root, this.axiom.evidenceRoot) || within(this.axiom.evidenceRoot, plan.root))) {
      throw new EffectivePolicyError("forbidden", "The trusted evidence archive must stay outside the integration checkout.");
    }
    const guardedPaths = [...new Set([...protectedPaths, ...commandPaths(plan)])];
    if (brief.ownedPaths.some((owned) => guardedPaths.some((guarded) => overlaps(owned, guarded)))) {
      throw new EffectivePolicyError("forbidden", "Worker scope overlaps an authoritative verification path.");
    }
    const outsideScope = await this.axiom.snapshot({ root: plan.root, excludedPaths: brief.ownedPaths, extraFiles: guardedPaths });
    const version: AuthorityDetails = {
      type: "policy_authority", revision,
      authorityDigest: digest([axiomRevision, plan.root, brief, requirements, protectedPaths, host, reviewerId]),
      protectedSourceDigest: outsideScope.digest,
      planDigest: digest(plan),
    };
    for (const event of store.eventsFor(taskId)) {
      const previous = event.details;
      if (previous?.type !== "policy_authority") continue;
      if (previous.revision > revision) throw new EffectivePolicyError("stale", "A later task authority version is already recorded.");
      if (previous.revision !== revision) continue;
      if (previous.authorityDigest !== version.authorityDigest) {
        throw new EffectivePolicyError("authority_conflict", "A task authority version cannot be redefined.");
      }
      if (previous.protectedSourceDigest !== version.protectedSourceDigest || previous.planDigest !== version.planDigest) {
        throw new EffectivePolicyError("stale", "Authoritative verification or out-of-scope source changed.");
      }
    }
    if (!brief.criteria.some(({ required }) => required)) {
      throw new EffectivePolicyError("invalid_input", "The canonical brief must include mandatory evidence.");
    }
    const request = workerAssignmentRequestSchema.parse({ task, session, brief });
    const fingerprint = digest([intent, grant, request, version]);
    return { request, fingerprint, version, plan, host, reviewerId };
  }

  async #current(admissionId: string) {
    const admission = this.options.store.getEvent(admissionId);
    const details = admission?.details;
    if (!admission || details?.type !== "policy_admission") {
      throw new EffectivePolicyError("not_found", "No admitted delegation matches this reference.");
    }
    const current = await this.#prepare(details.requestId, details.sessionId);
    if (current.version.revision !== details.revision || current.fingerprint !== details.fingerprint) {
      throw new EffectivePolicyError("stale", "The admitted action, grant, policy or verification requirements changed.");
    }
    return { ...current, admission };
  }

  #assignment(taskId: TaskId, sessionId: SessionId, value: unknown): WorkerAssignment {
    const parsed = workerAssignmentSchema.safeParse(value);
    if (!parsed.success || parsed.data.taskId !== taskId || parsed.data.sessionId !== sessionId) {
      throw new EffectivePolicyError("invalid_input", "The worker assignment must match the admitted task and session.");
    }
    return parsed.data;
  }

  #source(plan: VerificationRun["plan"]) {
    return this.axiom.snapshot({ root: plan.root, extraFiles: commandPaths(plan) });
  }

  #write(event: Event): Write {
    try {
      return this.options.store.appendEvent(event);
    } catch (error) {
      if (!(error instanceof OperationalStoreError) || error.code !== "identity_conflict") throw error;
      const prior = this.options.store.getEvent(event.id);
      if (prior && digest({ ...prior, occurredAt: event.occurredAt }) === digest(event)) return "duplicate";
      throw new EffectivePolicyError("authority_conflict", "A different outcome already owns this policy record.");
    }
  }
}
