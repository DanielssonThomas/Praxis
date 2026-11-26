import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
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
  workerRoot: string;
}

interface Completion extends IntegrationResult {
  review: { reviewerId: string; sourceDigest: string; receiptDigest: string };
  verification: VerificationRun;
}

type Details = Extract<NonNullable<Event["details"]>, { type: `policy_${string}` }>;
type AuthorityDetails = Extract<Details, { type: "policy_authority" }>;
type SettlementDetails = Extract<Details, { type: "policy_settlement" }>;
interface IntegrationScope {
  admission: Event;
  request: WorkerAssignmentRequest;
  plan: VerificationRun["plan"];
  version: AuthorityDetails;
  guardedPaths: readonly string[];
}
type Write = "inserted" | "duplicate";
type ErrorCode = "invalid_input" | "forbidden" | "not_found" | "authority_conflict" | "stale" | "unavailable" | "limit";
const terminal = new Set<string>(["completed", "failed", "stopped", "interrupted"]);

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
    const authority = policyEvent(eventId("authority", [request.task.id, version.revision]), "task.policy_authorized", request.task.id, version);
    const admission = policyEvent(admissionId, "task.delegation_admitted", request.task.id, {
      type: "policy_admission", requestId: eventIdSchema.parse(requestId), sessionId: request.session.id, revision: version.revision,
      fingerprint, sourceDigest: source.digest, sourceRevision: source.revision,
    });
    let write: Write;
    try {
      write = this.options.store.claimPolicyAdmission(authority, admission, prepared.plan.task.limits);
    } catch (error) {
      if (!(error instanceof OperationalStoreError)) throw error;
      if (error.code === "policy_limit") throw new EffectivePolicyError("limit", error.message);
      if (error.code === "policy_stale") throw new EffectivePolicyError("stale", error.message);
      if (error.code !== "identity_conflict") throw error;
      throw new EffectivePolicyError("authority_conflict", "An incompatible delegation or task authority is already recorded.");
    }
    return { admissionId, request, write, source };
  }

  readAdmission(requestId: string) {
    const admission = this.options.store.getEvent(eventId("admission", eventIdSchema.parse(requestId)));
    if (!admission || admission.details?.type !== "policy_admission") return undefined;
    const { details } = admission;
    const launch = this.options.store.getEvent(eventId("launch", admission.id))?.details;
    const settlement = this.options.store.getEvent(eventId("settlement", admission.id))?.details;
    return {
      admissionId: admission.id, sessionId: details.sessionId, revision: details.revision,
      source: { digest: details.sourceDigest, revision: details.sourceRevision },
      assignment: launch?.type === "policy_launch" ? launch.assignment : undefined,
      settlement: settlement?.type === "policy_settlement"
        ? { status: settlement.status, receiptDigest: settlement.receiptDigest } : undefined,
    };
  }

  /** Call inside prepareWorkspace, after staging and immediately before starting the worker. */
  async verifyStaging(admissionId: string, workerRoot: string): Promise<Write> {
    const current = await this.#current(admissionId);
    const root = await this.#workerRoot(current.plan.root, workerRoot);
    const [staged, integrated] = await Promise.all([this.#source(current.plan, root), this.#source(current.plan)]);
    const { sourceDigest, sourceRevision } = current.details;
    if (staged.digest !== sourceDigest || integrated.digest !== sourceDigest
      || staged.revision !== sourceRevision || integrated.revision !== sourceRevision) {
      throw new EffectivePolicyError("stale", "The staged workspace and integration checkout must match the admitted source.");
    }
    return this.#write(policyEvent(eventId("stage", current.admission.id), "task.delegation_staged", current.request.task.id, {
      type: "policy_stage", admissionId: current.admission.id, workspaceDigest: digest(root),
    }));
  }

  async recordLaunch(admissionId: string, value: unknown): Promise<Write> {
    const { admission, request } = await this.#current(admissionId);
    const assignment = this.#assignment(request.task.id, request.session.id, value);
    if (this.options.store.getEvent(eventId("stage", admission.id))?.details?.type !== "policy_stage") {
      throw new EffectivePolicyError("invalid_input", "Verify the exact staged workspace before recording the native launch.");
    }
    return this.#write(policyEvent(eventId("launch", admission.id), "task.delegation_launched", request.task.id, {
      type: "policy_launch", admissionId: admission.id, assignment,
    }));
  }

  recordSettlement(admissionId: string, assignment: WorkerAssignment, observation: WorkerObservation): Write {
    const { admission, details } = this.#admission(admissionId);
    const session = this.options.store.getSession(details.sessionId);
    if (!session) throw new EffectivePolicyError("not_found", "The admitted session is unavailable.");
    const result = this.#receipt(admission.id, session.taskId, session.id, assignment, observation);
    return this.#write(policyEvent(eventId("settlement", admission.id), "task.delegation_settled", session.taskId, {
      type: "policy_settlement", admissionId: admission.id, ...result,
    }));
  }

  /** Run admitted checks only from the trusted, isolated verification process. */
  async verify(admissionId: string, options: VerifyOptions = {}): Promise<VerificationRun> {
    const { plan, host, admission } = await this.#current(admissionId);
    this.#completedSettlement(admission.id);
    return this.axiom.verify(plan, host, options);
  }

  async inspectIntegration(input: IntegrationResult) {
    const current = await this.#current(input.admissionId);
    return this.#inspect(current, input);
  }

  async complete(input: Completion): Promise<{ verification: VerificationReport; write?: Write }> {
    const current = await this.#current(input.admissionId);
    if (input.review?.reviewerId !== current.reviewerId) {
      throw new EffectivePolicyError("forbidden", "The integrated result requires its authorized reviewer.");
    }
    const integrated = await this.#inspect(current, input);
    if (input.review.sourceDigest !== integrated.source.digest || input.review.receiptDigest !== integrated.receiptDigest) {
      throw new EffectivePolicyError("stale", "The integrated source or settled worker result changed after review.");
    }
    const run = input.verification;
    if (!run || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(run.id) || digest(run.host ?? null) !== digest(current.host)
      || digest(run.plan ?? null) !== current.version.planDigest || !Array.isArray(run.report?.checks)) {
      throw new EffectivePolicyError("stale", "The evidence must come from the approved verification plan and host.");
    }
    const assessed = await this.axiom.assess({ ...run, plan: current.plan, host: current.host });
    const settledAt = this.#completedSettlement(current.admission.id).occurredAt;
    const checks = await Promise.all(assessed.checks.map(async (check) => {
      if (!check.required || check.outcome.status !== "passed") return check;
      const observedAt = check.evidenceId && await this.axiom.evidenceStartedAt(check.evidenceId).catch(() => undefined);
      if (observedAt && Date.parse(observedAt) >= Date.parse(settledAt)) return check;
      return { ...check, outcome: { status: "blocked", reason: "Observed evidence must be fresh for the admitted native run." } };
    }));
    const conforms = assessed.conforms && checks.every((check) => !check.required || check.outcome.status === "passed");
    const verification = { conforms, checks };
    if (!conforms) return { verification };

    const final = await this.#current(input.admissionId);
    const { source } = await this.#inspect(final, input);
    if (digest(source) !== digest(integrated.source)) throw new EffectivePolicyError("stale", "The integrated source changed during completion.");
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
    this.#requireIsolatedRoot(plan.root);
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
    return { request, fingerprint, version, plan, host, reviewerId, guardedPaths };
  }

  #admission(admissionId: string) {
    const admission = this.options.store.getEvent(admissionId);
    const details = admission?.details;
    if (!admission || details?.type !== "policy_admission") {
      throw new EffectivePolicyError("not_found", "No admitted delegation matches this reference.");
    }
    return { admission, details };
  }

  async #current(admissionId: string) {
    const { admission, details } = this.#admission(admissionId);
    const current = await this.#prepare(details.requestId, details.sessionId);
    if (current.version.revision !== details.revision || current.fingerprint !== details.fingerprint) {
      throw new EffectivePolicyError("stale", "The admitted action, grant, policy or verification requirements changed.");
    }
    return { ...current, admission, details };
  }

  #assignment(taskId: TaskId, sessionId: SessionId, value: unknown): WorkerAssignment {
    const parsed = workerAssignmentSchema.safeParse(value);
    if (!parsed.success || parsed.data.taskId !== taskId || parsed.data.sessionId !== sessionId) {
      throw new EffectivePolicyError("invalid_input", "The worker assignment must match the admitted task and session.");
    }
    return parsed.data;
  }

  #receipt(admissionId: EventId, taskId: TaskId, sessionId: SessionId, value: unknown, observation: WorkerObservation) {
    const assignment = this.#assignment(taskId, sessionId, value);
    const launch = this.options.store.getEvent(eventId("launch", admissionId))?.details;
    if (launch?.type !== "policy_launch" || digest(launch.assignment) !== digest(assignment)) {
      throw new EffectivePolicyError("invalid_input", "The native result must match the recorded launch.");
    }
    const snapshot = runtimeSessionSnapshotSchema.safeParse(observation?.snapshot);
    const usage = usageSchema.safeParse(observation?.usage);
    if (!snapshot.success || snapshot.data.taskId !== taskId || snapshot.data.sessionId !== sessionId
      || !terminal.has(snapshot.data.status) || !usage.success || usage.data.sessionId !== sessionId) {
      throw new EffectivePolicyError("invalid_input", "The exact native worker must have a settled observation.");
    }
    return { status: snapshot.data.status as SettlementDetails["status"], receiptDigest: digest([assignment, snapshot.data, usage.data]) };
  }

  #completedSettlement(admissionId: EventId) {
    const event = this.options.store.getEvent(eventId("settlement", admissionId));
    if (!event || event.details?.type !== "policy_settlement" || event.details.status !== "completed") {
      throw new EffectivePolicyError("invalid_input", "Record the admitted worker’s successful native settlement before review.");
    }
    return { occurredAt: event.occurredAt, receiptDigest: event.details.receiptDigest };
  }

  async #inspect(current: IntegrationScope, input: IntegrationResult) {
    const { admission, request, plan, version, guardedPaths } = current;
    const result = this.#receipt(admission.id, request.task.id, request.session.id, input.assignment, input.observation);
    if (this.#completedSettlement(admission.id).receiptDigest !== result.receiptDigest) {
      throw new EffectivePolicyError("stale", "The worker observation changed after its recorded settlement.");
    }
    const root = await this.#workerRoot(plan.root, input.workerRoot);
    const stage = this.options.store.getEvent(eventId("stage", admission.id))?.details;
    if (stage?.type !== "policy_stage" || stage.workspaceDigest !== digest(root)) {
      throw new EffectivePolicyError("forbidden", "The result must come from the workspace staged for the admitted worker.");
    }
    const [worker, outside, source] = await Promise.all([
      this.#source(plan, root),
      this.axiom.snapshot({ root, excludedPaths: plan.task.ownedPaths, extraFiles: guardedPaths }),
      this.#source(plan),
    ]);
    if (outside.digest !== version.protectedSourceDigest || worker.digest !== source.digest) {
      throw new EffectivePolicyError("stale", "The scoped worker result differs from the integrated checkout or changed protected files.");
    }
    return { source, receiptDigest: result.receiptDigest };
  }

  #requireIsolatedRoot(root: string): void {
    for (const trusted of [this.axiom.evidenceRoot, this.axiom.axiomRoot]) {
      if (trusted && (within(root, trusted) || within(trusted, root))) {
        throw new EffectivePolicyError("forbidden", "The source and worker checkouts must stay separate from trusted Axiom and evidence.");
      }
    }
  }

  async #workerRoot(integrationRoot: string, value: string): Promise<string> {
    if (!isAbsolute(value)) throw new EffectivePolicyError("invalid_input", "Use the native worker’s absolute workspace path.");
    const root = await realpath(value);
    this.#requireIsolatedRoot(root);
    if (within(integrationRoot, root) || within(root, integrationRoot)) {
      throw new EffectivePolicyError("forbidden", "The staged workspace must be separate from the integration checkout.");
    }
    return root;
  }

  #source(plan: VerificationRun["plan"], root = plan.root) {
    return this.axiom.snapshot({ root, extraFiles: commandPaths(plan) });
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
