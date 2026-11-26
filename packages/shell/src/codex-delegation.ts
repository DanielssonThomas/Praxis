import { fork } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CodexExecutor } from "@praxis/codex-runtime";
import { runtimeSessionSnapshotSchema } from "@praxis/contracts";
import type { Action, EventId, RuntimeSessionSnapshot, WorkerAssignment, WorkerObservation } from "@praxis/contracts";
import { EffectivePolicyService } from "@praxis/management";
import { mcpAuthoritySchema } from "@praxis/mcp";
import type { McpGrant } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";
import {
  checkoutMatches, cloneCodexCheckout, codexDigest, codexProfileIdentity, readCodexDelegation,
  requireExternalCodexControls, resolveCodexEnrollment, stageCodexProfile, workerProcessEnvironment,
} from "./codex-delegation-config.js";
import { CodexObservationJournal, terminalObservation, visibleCodexObservation } from "./codex-delegation-journal.js";
import type { CodexObservationRecord } from "./codex-delegation-journal.js";

type ResolvedEnrollment = Awaited<ReturnType<typeof resolveCodexEnrollment>>;
type ApprovedRequest = { requestId: EventId; action: Action; actorId: string };
export interface CodexRegistration {
  assignment: WorkerAssignment;
  observation: WorkerObservation;
}

export class CodexDelegationError extends Error {
  constructor(readonly code: "invalidated" | "uncertain", message: string) {
    super(message);
    this.name = "CodexDelegationError";
  }
}

const invalidated = () => new CodexDelegationError("invalidated", "Current authority does not approve this exact Codex assignment.");
const uncertain = () => new CodexDelegationError("uncertain", "The Codex start could not be verified. Check Overview for its observed state.");
const startTimeoutMs = 18_000;
const observationIntervalMs = 500;

function delegationRequest(store: OperationalStore, requestId: string): ApprovedRequest | undefined {
  const record = store.getEvent(requestId);
  if (record?.kind !== "action.requested" || record.details?.type !== "action_request") return;
  const { action, actorId } = record.details;
  if (action.kind === "task.delegate" && action.target.kind === "task") return { requestId: record.id, action, actorId };
}

export function approvedCodexRequest(store: OperationalStore, requestId: string, scopeDigest: string, now = Date.now()): ApprovedRequest {
  const request = delegationRequest(store, requestId);
  if (!request) throw invalidated();
  const stages = store.eventsFor(request.action.id).flatMap(({ details }) => details?.type === "action_lifecycle"
    && details.requestId === requestId && details.actionId === request.action.id ? [details.transition] : []);
  const evaluations = stages.filter((transition) => transition.stage === "evaluation");
  const decisions = stages.filter((transition) => transition.stage === "decision");
  const evaluation = evaluations[0]?.value;
  const decision = decisions[0]?.value;
  if (evaluations.length !== 1 || decisions.length !== 1 || stages.some(({ stage }) => stage === "settlement")
    || evaluation?.mode !== "approval" || decision?.kind !== "approve"
    || evaluation.approval.actionId !== request.action.id || evaluation.approval.id !== decision.approvalId
    || evaluation.scopeDigest !== scopeDigest || decision.scopeDigest !== scopeDigest || Date.parse(evaluation.expiresAt) <= now) {
    throw invalidated();
  }
  return request;
}

function canDelegate(request: ApprovedRequest, grants: McpGrant[]): boolean {
  const taskId = taskTarget(request);
  return grants.some((grant) => grant.principalId === request.actorId && grant.taskIds.includes(taskId)
    && grant.actionKinds.includes("task.delegate"));
}

function taskTarget(request: ApprovedRequest) {
  if (request.action.target.kind !== "task" || request.action.kind !== "task.delegate") throw invalidated();
  return request.action.target.id;
}

function journal(workerRoot: string) {
  return new CodexObservationJournal(join(workerRoot, ".observations"));
}

function runDetached(requestId: EventId, fingerprint: string): Promise<RuntimeSessionSnapshot> {
  const script = fileURLToPath(new URL("./codex-delegation-runner.js", import.meta.url));
  const child = fork(script, ["run", requestId, fingerprint], { detached: true, execPath: process.execPath,
    env: workerProcessEnvironment(), execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.unref();
  child.channel?.unref();
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(uncertain()), startTimeoutMs);
    timer.unref();
    const unverified = () => { clearTimeout(timer); reject(uncertain()); };
    child.once("exit", unverified);
    child.once("error", unverified);
    child.once("message", (message) => {
      clearTimeout(timer);
      if (message && typeof message === "object" && "invalidated" in message) {
        reject(invalidated());
        return;
      }
      const snapshot = runtimeSessionSnapshotSchema.safeParse(message);
      if (snapshot.success) accept(snapshot.data);
      else reject(uncertain());
    });
  });
}

export class CodexDelegationService {
  readonly #store: OperationalStore;

  constructor(private readonly configFile: string, private readonly mcpFile: string, private readonly database: string,
    private readonly operatorDigest: string) {
    this.#store = new OperationalStore(database);
  }

  close(): void {
    this.#store.close();
  }

  async preview(request: ApprovedRequest): Promise<string | undefined> {
    try { return (await this.#prepare(request)).fingerprint; } catch { return undefined; }
  }

  async execute(request: ApprovedRequest, scopeDigest: string): Promise<RuntimeSessionSnapshot> {
    const { enrollment } = await this.#againstApproval(request, scopeDigest);
    const snapshot = await runDetached(request.requestId, scopeDigest);
    if (snapshot.taskId !== enrollment.taskId || snapshot.sessionId !== enrollment.sessionId) throw uncertain();
    return snapshot;
  }

  async list(): Promise<CodexRegistration[]> {
    const [config, grants] = await Promise.all([readCodexDelegation(this.configFile), this.#loadGrants()]);
    const records = await journal(config.workerRoot).list();
    return records.flatMap((record) => {
      if (!this.#matchesRegistration(record, grants)
        || !config.assignments.some(({ taskId, sessionId }) => taskId === record.assignment.taskId && sessionId === record.assignment.sessionId)) return [];
      return [{ assignment: record.assignment, observation: visibleCodexObservation(record) }];
    });
  }

  async runApproved(requestId: string, scopeDigest: string, acknowledge: (snapshot: RuntimeSessionSnapshot) => Promise<void>): Promise<void> {
    const request = approvedCodexRequest(this.#store, requestId, scopeDigest);
    const prepared = await this.#againstApproval(request, scopeDigest);
    const { executorOptions, enrollment, policy, profile, profileIdentity } = prepared;
    const admission = await policy.admit(requestId, enrollment.sessionId, prepared.policyFingerprint).catch(() => { throw invalidated(); });
    if (admission.write !== "inserted") throw uncertain();

    let passedFinalAuthorization = false;
    const executor = new CodexExecutor({
      ...executorOptions,
      workspaceOnly: true,
      prepareWorkspace: async ({ workspace, signal }) => {
        await cloneCodexCheckout(enrollment.authority.root, workspace, enrollment.sourceRevision, signal);
        if (await policy.verifyStaging(admission.admissionId, workspace) !== "inserted") throw invalidated();
      },
      prepareProfile: ({ codexHome }) => stageCodexProfile(profile, codexHome, profileIdentity),
      authorizeLaunch: async ({ workspace }) => {
        await this.#againstApproval(request, scopeDigest);
        if (await policy.verifyStaging(admission.admissionId, workspace) !== "duplicate") throw invalidated();
        approvedCodexRequest(this.#store, requestId, scopeDigest);
        passedFinalAuthorization = true;
      },
    });
    const assignment = await executor.createAssignment(admission.request).catch(() => {
      throw passedFinalAuthorization ? uncertain() : invalidated();
    });
    const record = (observation: WorkerObservation): CodexObservationRecord => ({
      schemaVersion: 1, requestId: request.requestId, admissionId: admission.admissionId, assignment, observation,
      observedAt: new Date().toISOString(), workerRoot: executor.workspaceFor(assignment),
    });
    const observations = journal(executorOptions.root);
    try {
      await policy.recordLaunch(admission.admissionId, assignment);
      const initial = executor.inspectAssignment(assignment);
      await observations.save(record(initial));
      await acknowledge(initial.snapshot);
      const completion = executor.waitAssignment(assignment);
      for (;;) {
        const terminal = await Promise.race([completion, delay(observationIntervalMs).then(() => undefined)]);
        if (terminal) {
          await observations.save(record(terminal));
          policy.recordSettlement(admission.admissionId, assignment, terminal);
          if (terminal.usage.metering === "reported") this.#store.recordUsageObservation(terminal.usage, new Date().toISOString());
          return;
        }
        const current = executor.inspectAssignment(assignment);
        if (!terminalObservation(current)) await observations.save(record(current));
      }
    } catch {
      executor.stopAssignment(assignment);
      await executor.waitAssignment(assignment).catch(() => undefined);
      throw uncertain();
    }
  }

  async result(requestId: string) {
    const { record } = await this.#reviewContext(requestId);
    return { assignment: record.assignment, observation: record.observation, workspace: record.workerRoot };
  }

  async review(requestId: string) {
    const { record, policy } = await this.#reviewContext(requestId);
    return await policy.inspectIntegration(record);
  }

  async complete(requestId: string, sourceDigest: string, receiptDigest: string) {
    const { record, policy, enrollment } = await this.#reviewContext(requestId);
    const reviewed = await policy.inspectIntegration(record);
    if (reviewed.source.digest !== sourceDigest || reviewed.receiptDigest !== receiptDigest) throw invalidated();
    const host = enrollment.authority.verificationHost;
    if (!host || typeof host !== "object" || !("version" in host) || !("os" in host) || !("surface" in host)
      || host.version !== process.version || host.os !== `${process.platform}-${process.arch}` || host.surface !== "cli") throw invalidated();
    const verification = await policy.verify(record.admissionId);
    return policy.complete({ ...record, review: { reviewerId: enrollment.authority.reviewerId, sourceDigest, receiptDigest }, verification });
  }

  async #reviewContext(requestId: string) {
    const request = delegationRequest(this.#store, requestId);
    if (!request) throw invalidated();
    const resources = await this.#resources(request, false);
    const record = await journal(resources.workerRoot).get(requestId);
    if (!record || !terminalObservation(record.observation) || !this.#matchesRegistration(record, await this.#loadGrants())) throw invalidated();
    const policy = await this.#policy(resources);
    policy.recordSettlement(record.admissionId, record.assignment, record.observation);
    return { record, policy, enrollment: resources.enrollment };
  }

  #matchesRegistration(record: CodexObservationRecord, grants: McpGrant[]): boolean {
    const request = delegationRequest(this.#store, record.requestId);
    if (!request || taskTarget(request) !== record.assignment.taskId || !canDelegate(request, grants)
      || this.#store.getSession(record.assignment.sessionId)?.taskId !== record.assignment.taskId) return false;
    const events = this.#store.eventsFor(record.assignment.taskId);
    return events.some(({ id, details }) => id === record.admissionId && details?.type === "policy_admission"
      && details.requestId === record.requestId && details.sessionId === record.assignment.sessionId)
      && events.some(({ details }) => details?.type === "policy_launch" && details.admissionId === record.admissionId
        && codexDigest(details.assignment) === codexDigest(record.assignment));
  }

  async #againstApproval(request: ApprovedRequest, fingerprint: string) {
    try {
      const prepared = await this.#prepare(request);
      if (prepared.fingerprint !== fingerprint) throw invalidated();
      approvedCodexRequest(this.#store, request.requestId, fingerprint);
      return prepared;
    } catch { throw invalidated(); }
  }

  async #prepare(request: ApprovedRequest) {
    const resources = await this.#resources(request, true);
    const { enrollment, profile, program, axiomRoot, workerRoot, binaryIdentity, evidenceRoot } = resources;
    const policy = await this.#policy(resources);
    const [profileIdentity, plan] = await Promise.all([
      codexProfileIdentity(profile), policy.preview(request.requestId, enrollment.sessionId),
    ]);
    const executorOptions = { program, axiomRoot, root: workerRoot, model: profile.model };
    const fingerprint = codexDigest([plan.fingerprint, enrollment.sourceRevision, profile, profileIdentity, program,
      binaryIdentity, axiomRoot, workerRoot, evidenceRoot]);
    return { executorOptions, enrollment, policy, profile, profileIdentity, policyFingerprint: plan.fingerprint, fingerprint };
  }

  async #resources(request: ApprovedRequest, requireClean: boolean): Promise<ResolvedEnrollment> {
    const recorded = delegationRequest(this.#store, request.requestId);
    if (!recorded || codexDigest(recorded) !== codexDigest(request)) throw invalidated();
    const [config, grants] = await Promise.all([readCodexDelegation(this.configFile), this.#loadGrants()]);
    const taskId = taskTarget(request);
    const enrollment = config.assignments.find((candidate) => candidate.taskId === taskId);
    if (!enrollment || !canDelegate(recorded, grants)
      || grants.some(({ sessions }) => sessions.some(({ sessionId, assignment }) => sessionId === enrollment.sessionId && assignment !== undefined))) {
      throw invalidated();
    }
    const resources = await resolveCodexEnrollment(config, enrollment);
    await requireExternalCodexControls([resources.enrollment.authority.root, resources.workerRoot],
      [this.configFile, this.mcpFile, this.database]);
    if (!await checkoutMatches(resources.enrollment.authority.root, enrollment.sourceRevision, requireClean)) throw invalidated();
    return resources;
  }

  #policy(resources: ResolvedEnrollment) {
    const { axiomRoot, evidenceRoot } = resources;
    return EffectivePolicyService.open({ store: this.#store, axiomRoot, evidenceRoot, loadGrants: () => this.#loadGrants(),
      loadAuthority: async (taskId) => {
        const config = await readCodexDelegation(this.configFile);
        const row = config.assignments.find((candidate) => candidate.taskId === taskId);
        if (!row || row.sessionId !== resources.enrollment.sessionId || row.sourceRevision !== resources.enrollment.sourceRevision) return;
        return { ...row.authority, root: await realpath(row.authority.root) };
      },
    });
  }

  async #loadGrants() {
    const config = await readMcpAuthority(this.mcpFile);
    if (resolve(config.database) !== this.database || config.grants.some(({ tokenDigest }) => tokenDigest === this.operatorDigest)) throw invalidated();
    return config.grants;
  }
}

async function readMcpAuthority(file: string) {
  return mcpAuthoritySchema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function codexDelegationFromEnv() {
  const { PRAXIS_CODEX_DELEGATION_FILE: file, PRAXIS_MCP_CONFIG_FILE: mcpFile, PRAXIS_OPERATOR_TOKEN_DIGEST: operatorDigest } = process.env;
  if (!file || !mcpFile || !operatorDigest || process.platform !== "linux" || process.arch !== "x64") return;
  const db = resolve((await readMcpAuthority(mcpFile)).database);
  return new CodexDelegationService(resolve(file), resolve(mcpFile), db, operatorDigest);
}
