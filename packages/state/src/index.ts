import { DatabaseSync } from "node:sqlite";
import {
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

type StoredRecord = Task | Session | Event | Usage;
type WriteResult = "inserted" | "duplicate";
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
