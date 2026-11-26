import { createHash } from "node:crypto";
import { actionIdSchema, contractVersion, eventSchema, principalIdSchema } from "@praxis/contracts";
import type { Event, Usage } from "@praxis/contracts";
import { hermesAssignmentSchema } from "@praxis/hermes-runtime";
import type { HermesAssignment, HermesRuntime } from "@praxis/hermes-runtime";
import type { McpGrant } from "@praxis/mcp";
import { managementWorkSchema } from "@praxis/state";
import type { ManagementClaim, OperationalStore } from "@praxis/state";

export { EffectivePolicyError, EffectivePolicyService } from "./effective-policy.js";
export type { EffectiveTaskAuthority } from "./effective-policy.js";

const terminal = new Set(["completed", "failed", "stopped", "interrupted"]);
const leaseMs = 60_000;
const deduplicationMs = 23 * 60 * 60 * 1_000;
const failuresLimit = 3;
type Runtime = Pick<HermesRuntime, "submitTurn" | "inspectAssignment" | "inspectLiveAssignment">;

interface Options {
  store: OperationalStore;
  runtime: Runtime;
  loadGrant: () => Promise<McpGrant>;
  profile: string;
  principalId: string;
  concurrency: number;
  maxAttempts: number;
  pollMs?: number;
  now?: () => number;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventFor(kind: string, key: string, occurredAt: number, subject: Event["subject"], details?: Event["details"]): Event {
  return eventSchema.parse({
    schemaVersion: contractVersion, id: `event_management_${hash(`${kind}\0${key}`)}`, kind,
    occurredAt: new Date(occurredAt).toISOString(), subject, ...(details === undefined ? {} : { details }),
  });
}

export class ManagementService {
  readonly #options: Options;
  #pending?: Promise<void>;

  constructor(options: Options) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 10
      || !Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 5
      || (options.pollMs !== undefined && (!Number.isInteger(options.pollMs) || options.pollMs < 1 || options.pollMs > 30_000))) {
      throw new Error("Configure 1–10 concurrent background items, 1–5 attempts and a bounded polling interval.");
    }
    principalIdSchema.parse(options.principalId);
    this.#options = options;
  }

  get #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  async enqueue(value: unknown): Promise<"inserted" | "duplicate"> {
    const work = managementWorkSchema.parse(value);
    if (work.kind !== "direction" && work.kind !== "maintenance") {
      throw new Error("Worker questions and results enter through the authenticated report journal.");
    }
    const grant = await this.#readGrant();
    if (!grant.taskIds.includes(work.taskId)) throw new Error("The task is outside background scope.");
    return this.#options.store.management.enqueue(work, this.#now);
  }

  advance(): Promise<void> {
    this.#pending ??= this.#advance().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #readGrant(): Promise<McpGrant> {
    const grant = await this.#options.loadGrant();
    if (grant.principalId !== this.#options.principalId || grant.actionKinds.length > 0
      || grant.sessions.some(({ canReport }) => canReport)
      || grant.memoryProjects?.some(({ canWrite }) => canWrite)) {
      throw new Error("Background coordination requires its configured read-only MCP principal.");
    }
    this.#options.store.management.bindScope(JSON.stringify([this.#options.profile, grant.principalId]));
    return grant;
  }

  async #advance(): Promise<void> {
    const { store, concurrency } = this.#options;
    const grant = await this.#readGrant();
    for (const event of store.management.workerReports(grant.taskIds)) {
      if (event.subject.kind !== "session" || event.details?.type !== "worker_report") continue;
      const source = store.getSession(event.subject.id);
      if (source === undefined) continue;
      store.management.enqueue({
        id: event.id, taskId: source.taskId, sourceSessionId: source.id,
        kind: event.kind.slice("worker.".length), instruction: event.details.message,
      }, this.#now);
    }
    const claims = store.management.claim(concurrency, this.#now, leaseMs);
    const outcomes = await Promise.allSettled(claims.map((claim) => this.#process(claim, grant)));
    if (outcomes.some(({ status }) => status === "rejected")) {
      throw new Error("One or more background checkpoints could not be saved.");
    }
  }

  async #process(claim: ManagementClaim, grant: McpGrant): Promise<void> {
    const { store, runtime, pollMs = 1_000 } = this.#options;
    const task = store.getTask(claim.work.taskId);
    if (task === undefined || !grant.taskIds.includes(task.id)) {
      return this.#escalate(claim, "The task is no longer available to background management.", true);
    }
    if (claim.runId === undefined && this.#now - claim.startedAt >= deduplicationMs) {
      return this.#escalate(claim, "The native submission could no longer be safely replayed.", true);
    }

    let assignment: HermesAssignment;
    let outcome: Awaited<ReturnType<Runtime["inspectLiveAssignment"]>> | undefined;
    try {
      if (claim.runId === undefined) {
        const prompt = "Review this scoped Praxis background work. Inspect relevant state through read-only MCP."
          + " Return an advisory response for the operator. Use the recorded work as context.\n"
          + JSON.stringify({ task, ...claim.work });
        assignment = await runtime.submitTurn(claim.session, prompt, `management-${hash(claim.work.id)}-${claim.attempt}`);
      } else {
        assignment = hermesAssignmentSchema.parse({
          schemaVersion: contractVersion, taskId: task.id, sessionId: claim.session.id, runId: claim.runId,
        });
      }
      if (assignment.sessionId !== claim.session.id || assignment.taskId !== task.id
        || (claim.runId !== undefined && claim.runId !== assignment.runId)) throw new Error("Foreign native assignment.");
      if (claim.runId !== undefined) {
        const current = await runtime.inspectAssignment(assignment);
        if (current.taskId !== task.id || current.sessionId !== claim.session.id || current.status === "unknown") {
          throw new Error("Unverified native status.");
        }
        if (terminal.has(current.status)) {
          outcome = await runtime.inspectLiveAssignment(assignment);
          if (outcome.snapshot.taskId !== task.id || outcome.snapshot.sessionId !== claim.session.id
            || outcome.usage.sessionId !== claim.session.id || !terminal.has(outcome.snapshot.status)) {
            throw new Error("Unverified terminal receipt.");
          }
        }
      }
    } catch {
      const failures = claim.failures + 1;
      if (failures >= failuresLimit) return this.#escalate(claim, "The native background outcome is unverified.", true);
      store.management.update(claim, { state: "active", failures, availableAt: this.#now + pollMs * 2 ** failures });
      return;
    }

    if (outcome === undefined) {
      store.management.update(claim, { state: "active", runId: assignment.runId, availableAt: this.#now + pollMs });
      return;
    }
    const { snapshot, usage } = outcome;
    if (snapshot.status === "completed" && snapshot.output.availability === "available") {
      store.management.update(claim, {
        state: "completed", result: snapshot.output, availableAt: this.#now,
        usage, events: [
          this.#usageEvent(usage),
          eventFor("management.completed", claim.work.id, this.#now, { kind: "task", id: task.id }),
        ],
      });
    } else if (claim.attempt < this.#options.maxAttempts) {
      store.management.update(claim, {
        state: "queued", availableAt: this.#now + pollMs * 2 ** claim.attempt,
        usage, events: [this.#usageEvent(usage)],
      });
    } else this.#escalate(claim, "Background management reached its native attempt limit.", false, usage);
  }

  #usageEvent(usage: Usage): Event {
    return eventFor("management.usage", usage.id, this.#now, { kind: "usage", id: usage.id });
  }

  #escalate(claim: ManagementClaim, reason: string, hold: boolean, usage?: Usage): void {
    const { store, principalId } = this.#options;
    const subject = { kind: "task", id: claim.work.taskId } as const;
    const event = eventFor("management.escalated", claim.work.id, this.#now, subject, {
      type: "management_escalation", workId: claim.work.id, actorId: principalIdSchema.parse(principalId), reason,
      action: {
        schemaVersion: contractVersion, id: actionIdSchema.parse(`action_management_${hash(claim.work.id)}`),
        kind: "management.review", target: subject,
      },
    });
    store.management.update(claim, {
      state: hold ? "held" : "escalated", availableAt: this.#now, usage,
      events: usage === undefined ? [event] : [this.#usageEvent(usage), event],
    });
  }
}
