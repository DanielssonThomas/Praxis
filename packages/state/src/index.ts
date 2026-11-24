import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  actionIdSchema,
  contractVersion,
  eventIdSchema,
  eventSchema,
  sessionIdSchema,
  sessionSchema,
  taskIdSchema,
  taskSchema,
  usageIdSchema,
  usageSchema,
} from "@praxis/contracts";
import type { Event, Session, Task, Usage } from "@praxis/contracts";
import type { ZodType } from "zod";
import { z } from "zod";

type StoredRecord = Task | Session | Event | Usage;
type WriteResult = "inserted" | "duplicate";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const controlStateSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("automated_write"), revision: z.uuid(), actionId: actionIdSchema }),
  z.strictObject({
    mode: z.literal("manual"), revision: z.uuid(), assignmentDigest: digest,
    pending: z.strictObject({
      afterMessageId: z.int().nonnegative(),
      textDigest: digest,
      outcome: z.enum(["submitting", "accepted", "uncertain"]),
    }).optional(),
  }),
]);
export type SessionControlState = z.infer<typeof controlStateSchema>;
type StoreErrorCode =
  | "invalid_record"
  | "identity_conflict"
  | "missing_reference"
  | "unsupported_version"
  | "storage_failure";

export class OperationalStoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OperationalStoreError";
  }
}

function storage<T>(operation: string, execute: () => T): T {
  try {
    return execute();
  } catch (error) {
    if (error instanceof OperationalStoreError) throw error;
    throw new OperationalStoreError("storage_failure", `Could not ${operation} operational state`, { cause: error });
  }
}

function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new OperationalStoreError("invalid_record", "Invalid operational record or ID", { cause: parsed.error });
}

function initialize(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const version = database.prepare("PRAGMA user_version").get()?.user_version;
    if (version === 0) {
      database.exec(`
        CREATE TABLE operational_records (
          sequence INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL,
          parent_id TEXT REFERENCES operational_records(id),
          subject_id TEXT
        ) STRICT;
        CREATE INDEX operational_events_by_subject ON operational_records(subject_id, sequence)
          WHERE subject_id IS NOT NULL;
        PRAGMA user_version = 1;
      `);
    } else if (version !== 1) {
      throw new OperationalStoreError("unsupported_version", `Unsupported operational database version ${version}`);
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS operational_events_by_kind
        ON operational_records(json_extract(payload, '$.kind'), sequence)
        WHERE subject_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS session_controls (
        session_id TEXT PRIMARY KEY REFERENCES operational_records(id),
        revision TEXT NOT NULL,
        payload TEXT NOT NULL
      ) STRICT
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export class OperationalStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = storage("open", () => new DatabaseSync(path, { timeout: 5_000 }));
    try {
      storage("initialize", () => initialize(this.#database));
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.isOpen) storage("close", () => this.#database.close());
  }

  recordTask(value: unknown): WriteResult {
    return this.#write(parseInput(taskSchema, value));
  }

  recordSession(value: unknown): WriteResult {
    const record = parseInput(sessionSchema, value);
    return this.#write(record, { parentId: record.taskId });
  }

  appendEvent(value: unknown): WriteResult {
    const record = parseInput(eventSchema, value);
    return this.#write(record, { subjectId: record.subject.id });
  }

  recordUsage(value: unknown): WriteResult {
    const record = parseInput(usageSchema, value);
    return this.#write(record, { parentId: record.sessionId });
  }

  recordUsageObservation(value: unknown, occurredAt: string): WriteResult {
    const usage = parseInput(usageSchema, value);
    if (usage.metering !== "reported") {
      throw new OperationalStoreError("invalid_record", "An observation requires reported usage");
    }
    const observation = parseInput(eventSchema, {
      schemaVersion: contractVersion,
      id: `event_usage_${createHash("sha256").update(usage.id).digest("hex")}`,
      kind: "usage.observed",
      occurredAt,
      subject: { kind: "usage", id: usage.id },
    });
    const hasObservation = () => this.eventsFor(usage.id).some(
      ({ kind, subject }) => kind === observation.kind && subject.kind === "usage",
    );
    const saved = this.getUsage(usage.id);
    if (saved !== undefined && JSON.stringify(saved) === JSON.stringify(usage) && hasObservation()) return "duplicate";

    return this.#transaction(() => {
      const written = this.#write(usage, { parentId: usage.sessionId });
      if (hasObservation()) return written;
      return this.#write(observation, { subjectId: usage.id });
    });
  }

  getTask(id: string): Task | undefined {
    return this.#read(parseInput(taskIdSchema, id), taskSchema);
  }

  getSession(id: string): Session | undefined {
    return this.#read(parseInput(sessionIdSchema, id), sessionSchema);
  }

  getEvent(id: string): Event | undefined {
    return this.#read(parseInput(eventIdSchema, id), eventSchema);
  }

  getUsage(id: string): Usage | undefined {
    return this.#read(parseInput(usageIdSchema, id), usageSchema);
  }

  eventsFor(subjectId: string): Event[] {
    return storage("read", () => this.#database
      .prepare("SELECT payload FROM operational_records WHERE subject_id = ? ORDER BY sequence")
      .all(subjectId)
      .map((row) => eventSchema.parse(JSON.parse(String(row.payload)))));
  }

  eventsOfKind(kind: string): Event[] {
    return storage("read", () => this.#database.prepare(`
      SELECT payload FROM operational_records
      WHERE subject_id IS NOT NULL AND json_extract(payload, '$.kind') = ?
      ORDER BY sequence
    `).all(kind).map((row) => eventSchema.parse(JSON.parse(String(row.payload)))));
  }

  sessionControl(id: string): SessionControlState | undefined {
    const sessionId = parseInput(sessionIdSchema, id);
    return storage("read", () => {
      const row = this.#database.prepare("SELECT payload FROM session_controls WHERE session_id = ?").get(sessionId);
      return row === undefined ? undefined : controlStateSchema.parse(JSON.parse(String(row.payload)));
    });
  }

  compareSessionControl(
    id: string, expected: string | undefined, next: SessionControlState | undefined, event?: Event,
  ): boolean {
    const sessionId = parseInput(sessionIdSchema, id);
    const revision = expected === undefined ? undefined : parseInput(z.uuid(), expected);
    const state = next === undefined ? undefined : parseInput(controlStateSchema, next);
    const observed = event === undefined ? undefined : parseInput(eventSchema, event);
    const compare = () => {
      if (state === undefined) {
        if (revision === undefined) return false;
        return this.#database.prepare("DELETE FROM session_controls WHERE session_id = ? AND revision = ?")
          .run(sessionId, revision).changes === 1;
      }
      const payload = JSON.stringify(state);
      if (revision === undefined) {
        return this.#database.prepare(`
          INSERT INTO session_controls (session_id, revision, payload) VALUES (?, ?, ?)
          ON CONFLICT(session_id) DO NOTHING
        `).run(sessionId, state.revision, payload).changes === 1;
      }
      return this.#database.prepare(`
        UPDATE session_controls SET revision = ?, payload = ? WHERE session_id = ? AND revision = ?
      `).run(state.revision, payload, sessionId, revision).changes === 1;
    };
    if (observed === undefined) return storage("write", compare);
    return this.#transaction(() => {
      const changed = compare();
      if (changed && this.#write(observed, { subjectId: observed.subject.id }) !== "inserted") {
        throw new OperationalStoreError("identity_conflict", "The control event was already recorded");
      }
      return changed;
    });
  }

  #transaction<T>(write: () => T): T {
    return storage("write", () => {
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        const result = write();
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  #read<T>(id: string, schema: ZodType<T>): T | undefined {
    return storage("read", () => {
      const row = this.#database.prepare("SELECT payload FROM operational_records WHERE id = ?").get(id);
      return row === undefined ? undefined : schema.parse(JSON.parse(String(row.payload)));
    });
  }

  #write(record: StoredRecord, { parentId, subjectId }: { parentId?: string; subjectId?: string } = {}): WriteResult {
    return storage("write", () => {
      if (parentId !== undefined) {
        const parent = this.#database.prepare("SELECT 1 FROM operational_records WHERE id = ?").get(parentId);
        if (parent === undefined) {
          throw new OperationalStoreError("missing_reference", `Operational record ${parentId} is required`);
        }
      }

      const payload = JSON.stringify(record);
      const insert = this.#database.prepare(`
        INSERT INTO operational_records (id, payload, parent_id, subject_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(record.id, payload, parentId ?? null, subjectId ?? null);
      if (insert.changes === 1) return "inserted";

      const existing = this.#database.prepare("SELECT payload FROM operational_records WHERE id = ?").get(record.id);
      if (existing?.payload === payload) return "duplicate";
      throw new OperationalStoreError("identity_conflict", `Operational record ${record.id} already exists with different content`);
    });
  }
}
