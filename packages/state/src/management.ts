import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  contractVersion, eventIdSchema, eventSchema, runtimeOutputSchema, sessionIdSchema, sessionSchema, taskIdSchema, workerReportMessageSchema,
} from "@praxis/contracts";
import type { Event, RuntimeOutput, Session, Task, Usage } from "@praxis/contracts";
import { z } from "zod";

export const managementWorkSchema = z.strictObject({
  id: eventIdSchema,
  taskId: taskIdSchema,
  sourceSessionId: sessionIdSchema.optional(),
  kind: z.enum(["direction", "question", "result", "blocked", "maintenance"]),
  instruction: workerReportMessageSchema,
});
export type ManagementWork = z.infer<typeof managementWorkSchema>;
type State = "queued" | "active" | "completed" | "escalated" | "held";

export interface ManagementEntry {
  work: ManagementWork;
  session: Session;
  state: State;
  attempt: number;
  failures: number;
  startedAt: number;
  runId?: string;
  result?: RuntimeOutput;
}

export interface ManagementClaim extends ManagementEntry {
  claim: string;
}

interface Update {
  state: State;
  availableAt: number;
  failures?: number;
  runId?: string;
  result?: RuntimeOutput;
  events?: readonly Event[];
  usage?: Usage;
}

type Row = Record<string, SQLOutputValue>;
interface Journal {
  transaction<T>(write: () => T): T;
  getTask(id: string): Task | undefined;
  getSession(id: string): Session | undefined;
  recordSession(session: Session): unknown;
  recordUsage(usage: Usage): unknown;
  appendEvent(event: Event): unknown;
}

export function initializeManagement(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS management_work (
      sequence INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      priority INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      available_at INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL DEFAULT 0,
      claim TEXT,
      lease_until INTEGER,
      run_id TEXT,
      result TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS management_due ON management_work(state, available_at, priority, sequence);
    CREATE TABLE IF NOT EXISTS management_scope (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL) STRICT;
  `);
}

function sessionFor(work: ManagementWork): Session {
  const digest = createHash("sha256").update(work.id).digest("hex");
  return sessionSchema.parse({ schemaVersion: contractVersion, id: `session_management_${digest}`, taskId: work.taskId });
}

function entry(row: Row): ManagementEntry {
  const work = managementWorkSchema.parse(JSON.parse(String(row.payload)));
  return {
    work, session: sessionFor(work), state: String(row.state) as State,
    attempt: Number(row.attempt), failures: Number(row.failures), startedAt: Number(row.started_at),
    ...(row.run_id === null ? {} : { runId: String(row.run_id) }),
    ...(row.result === null ? {} : { result: runtimeOutputSchema.parse(JSON.parse(String(row.result))) }),
  };
}

export class ManagementQueue {
  constructor(private readonly database: DatabaseSync, private readonly journal: Journal) {}

  bindScope(value: string): void {
    this.journal.transaction(() => {
      this.database.prepare("INSERT INTO management_scope (id, value) VALUES (1, ?) ON CONFLICT(id) DO NOTHING").run(value);
      if (this.database.prepare("SELECT value FROM management_scope WHERE id = 1").get()?.value !== value) {
        throw new Error("The management queue belongs to a different background profile or principal.");
      }
    });
  }

  workerReports(taskIds: readonly string[]): Event[] {
    return this.database.prepare(`
      SELECT report.payload FROM operational_records AS report
      JOIN operational_records AS session ON session.id = report.subject_id
      WHERE json_extract(report.payload, '$.kind') IN ('worker.question', 'worker.result', 'worker.blocked')
        AND json_extract(report.payload, '$.details.type') = 'worker_report'
        AND session.parent_id IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM management_work WHERE id = report.id)
      ORDER BY report.sequence LIMIT 128
    `).all(JSON.stringify(taskIds)).map(({ payload }) => eventSchema.parse(JSON.parse(String(payload))));
  }

  enqueue(value: unknown, now: number): "inserted" | "duplicate" {
    const work = managementWorkSchema.parse(value);
    const payload = JSON.stringify(work);
    return this.journal.transaction(() => {
      if (this.journal.getTask(work.taskId) === undefined
        || (work.sourceSessionId !== undefined && this.journal.getSession(work.sourceSessionId)?.taskId !== work.taskId)) {
        throw new Error("The management work must refer to a registered task and matching source session.");
      }
      const previous = this.database.prepare("SELECT payload FROM management_work WHERE id = ?").get(work.id);
      if (previous !== undefined) {
        if (previous.payload === payload) return "duplicate";
        throw new Error("The management work identity already records different content.");
      }
      this.journal.recordSession(sessionFor(work));
      const priority = work.kind === "direction" ? 0 : work.kind === "maintenance" ? 2 : 1;
      this.database.prepare("INSERT INTO management_work (id, payload, priority, available_at) VALUES (?, ?, ?, ?)")
        .run(work.id, payload, priority, now);
      return "inserted";
    });
  }

  list(): ManagementEntry[] {
    return this.database.prepare("SELECT * FROM management_work ORDER BY sequence").all().map(entry);
  }

  claim(concurrency: number, now: number, leaseMs: number): ManagementClaim[] {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error("Choose concurrency from 1 to 10.");
    return this.journal.transaction(() => {
      const occupied = Number(this.database.prepare(
        "SELECT COUNT(*) AS slots FROM management_work WHERE state IN ('active', 'held')",
      ).get()?.slots);
      const active = this.database.prepare(`
        SELECT * FROM management_work
        WHERE state = 'active' AND available_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
        ORDER BY available_at, sequence LIMIT ?
      `).all(now, now, concurrency);
      const queued = this.database.prepare(`
        SELECT * FROM management_work WHERE state = 'queued' AND available_at <= ?
        ORDER BY priority, sequence LIMIT ?
      `).all(now, Math.max(0, concurrency - occupied));
      return [...active, ...queued].map((row) => {
        const current = entry(row);
        const claim = randomUUID();
        const resumed = current.state === "active";
        const attempt = current.attempt + (resumed ? 0 : 1);
        const startedAt = resumed ? current.startedAt : now;
        this.database.prepare(`
          UPDATE management_work SET state = 'active', claim = ?, lease_until = ?, attempt = ?, started_at = ?
          WHERE id = ?
        `).run(claim, now + leaseMs, attempt, startedAt, current.work.id);
        return { ...current, state: "active", claim, attempt, startedAt };
      });
    });
  }

  update(current: ManagementClaim, next: Update): boolean {
    return this.journal.transaction(() => {
      const runId = next.state === "queued" ? null : next.runId ?? current.runId ?? null;
      const result = this.database.prepare(`
        UPDATE management_work SET state = ?, available_at = ?, failures = ?, run_id = ?, result = ?,
          claim = NULL, lease_until = NULL
        WHERE id = ? AND state = 'active' AND claim = ?
      `).run(next.state, next.availableAt, next.failures ?? 0, runId,
        next.result === undefined ? null : JSON.stringify(next.result), current.work.id, current.claim);
      if (result.changes !== 1) return false;
      if (next.usage !== undefined) this.journal.recordUsage(next.usage);
      for (const event of next.events ?? []) this.journal.appendEvent(event);
      return true;
    });
  }
}
