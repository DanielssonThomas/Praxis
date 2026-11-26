import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { eventIdSchema, runtimeSessionSnapshotSchema, usageSchema, workerAssignmentSchema } from "@praxis/contracts";
import type { WorkerObservation } from "@praxis/contracts";
import { z } from "zod";

const observationSchema = z.strictObject({ snapshot: runtimeSessionSnapshotSchema, usage: usageSchema });
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1), requestId: eventIdSchema, admissionId: eventIdSchema,
  assignment: workerAssignmentSchema, observation: observationSchema,
  observedAt: z.iso.datetime(), workerRoot: z.string().refine(isAbsolute),
}).refine(({ assignment, observation }) => assignment.runtime === "codex"
  && assignment.sessionId === observation.snapshot.sessionId && assignment.taskId === observation.snapshot.taskId
  && assignment.sessionId === observation.usage.sessionId, "The observation must identify the exact Codex worker assignment");

export type CodexObservationRecord = z.infer<typeof recordSchema>;
const terminal = new Set(["completed", "failed", "stopped", "interrupted"]);
const heartbeatLifetimeMs = 10_000;

export function terminalObservation(observation: WorkerObservation): boolean {
  return terminal.has(observation.snapshot.status);
}

export function visibleCodexObservation(record: CodexObservationRecord, now = Date.now()): WorkerObservation {
  if (terminalObservation(record.observation) || now - Date.parse(record.observedAt) < heartbeatLifetimeMs) return record.observation;
  const { snapshot, usage } = record.observation;
  return { snapshot: { ...snapshot, status: "unknown" }, usage };
}

export class CodexObservationJournal {
  constructor(private readonly root: string) {}

  async get(requestId: string): Promise<CodexObservationRecord | undefined> {
    const id = eventIdSchema.parse(requestId);
    try {
      const record = recordSchema.parse(JSON.parse(await readFile(join(this.root, `${id}.json`), "utf8")));
      return record.requestId === id ? record : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<CodexObservationRecord[]> {
    const files = await readdir(this.root).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const ids = files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5));
    const observed = await Promise.allSettled(ids.map((id) => this.get(id)));
    return observed.flatMap((entry) => entry.status === "fulfilled" && entry.value ? [entry.value] : []);
  }

  async save(value: unknown): Promise<void> {
    const record = recordSchema.parse(value);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600, flush: true });
      await rename(temporary, join(this.root, `${record.requestId}.json`));
      if (process.platform === "linux") {
        const directory = await open(this.root, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
