import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export const memoryId = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const noteKind = z.enum(["decision", "finding"]);
const noteTitle = z.string().trim().min(1).max(160).regex(/^[^\x00-\x1f\x7f]+$/);
const noteBody = z.string().trim().min(1).max(12_000).transform((text) => text.replaceAll("\r\n", "\n"));
const verification = z.string().trim().min(1).max(2_000);
const links = z.array(memoryId).max(16).refine((ids) => new Set(ids).size === ids.length, "Related notes must be unique");
const noteDetails = {
  kind: noteKind, verification: verification.optional(), relatedNoteIds: links,
};

export const recordMemorySchema = z.strictObject({
  projectId: memoryId, noteId: memoryId, title: noteTitle, body: noteBody, ...noteDetails,
  relatedNoteIds: links.default([]),
}).refine(({ kind, verification }) => kind !== "finding" || verification !== undefined, {
  path: ["verification"], message: "Record the evidence for a verified finding.",
});

export const retrieveMemorySchema = z.strictObject({
  projectId: memoryId,
  noteId: memoryId.optional(),
  query: z.string().trim().min(1).max(200).optional(),
  limit: z.int().min(1).max(50).default(20),
});

const metadataSchema = z.strictObject({ version: z.literal(1), createdAt: z.iso.datetime(), ...noteDetails });
type Metadata = z.infer<typeof metadataSchema>;
type Note = Omit<Metadata, "version"> & { id: string; title: string; body: string; relativePath: string };

const frontMatter = "---\npraxis-memory: ";
const contentDivider = "\n---\n\n# ";
const byteLimit = 128_000;
const sqliteBusy = 5;

export class MemoryError extends Error {
  constructor(readonly code: "disabled" | "identity_conflict" | "not_found" | "unavailable", message: string) {
    super(message);
  }
}

function errorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function nodeInfo(path: string) {
  try { return lstatSync(path); } catch (error) {
    if (errorCode(error, "ENOENT")) return;
    throw error;
  }
}

function directoryExists(path: string): boolean {
  const info = nodeInfo(path);
  if (info === undefined) return false;
  if (!info.isDirectory()) throw new MemoryError("unavailable", "The configured memory directory is unavailable.");
  return true;
}

function relativeNotePath(projectId: string, noteId: string): string {
  return `${projectId}/${noteId}.md`;
}

function relatedLinks(ids: string[]): string {
  return ids.length === 0 ? "" : "\n\n## Related notes\n\n" + ids.map((id) => `- [${id}](./${id}.md)`).join("\n");
}

function decode(markdown: string, projectId: string, id: string): Note | undefined {
  const normalized = markdown.replaceAll("\r\n", "\n");
  if (!normalized.startsWith(frontMatter)) return;
  const divider = normalized.indexOf(contentDivider);
  const invalid = () => new MemoryError("unavailable", "A Praxis memory note has an invalid Markdown header.");
  if (divider < 0) throw invalid();
  const content = normalized.slice(divider + contentDivider.length);
  const bodyStart = content.indexOf("\n\n");
  if (bodyStart < 0) throw invalid();
  const metadata = metadataSchema.parse(JSON.parse(normalized.slice(frontMatter.length, divider)));
  const title = noteTitle.parse(content.slice(0, bodyStart));
  const remainder = content.slice(bodyStart + 2).trimEnd();
  const suffix = relatedLinks(metadata.relatedNoteIds);
  const body = suffix && remainder.endsWith(suffix) ? remainder.slice(0, -suffix.length) : remainder;
  return { id, title, body, kind: metadata.kind, createdAt: metadata.createdAt, verification: metadata.verification,
    relatedNoteIds: metadata.relatedNoteIds, relativePath: relativeNotePath(projectId, id) };
}

function read(path: string, projectId: string, id: string) {
  let file;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error, "ENOENT")) return;
    throw error;
  }
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.size > byteLimit) {
      throw new MemoryError("unavailable", "A Praxis memory note is not a bounded regular Markdown file.");
    }
    const bytes = readFileSync(file);
    if (bytes.length > byteLimit) throw new MemoryError("unavailable", "A Praxis memory note is too large.");
    const note = decode(bytes.toString("utf8"), projectId, id);
    return note && { note, bytes, path };
  } finally { closeSync(file); }
}

function listProject(root: string, projectId: string) {
  const directory = join(root, projectId);
  if (!directoryExists(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
    const id = memoryId.safeParse(entry.name.slice(0, -3));
    if (!id.success) return [];
    const record = read(join(directory, entry.name), projectId, id.data);
    return record ? [record] : [];
  });
}

function listVault(root: string) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() && memoryId.safeParse(entry.name).success ? listProject(root, entry.name) : []);
}

function within(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(".." + sep));
}

export class ProjectMemory {
  readonly #directory: string;
  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  async record(input: z.infer<typeof recordMemorySchema>) {
    const { projectId, noteId, title, body, kind, verification, relatedNoteIds } = input;
    const outcome = await this.#serialize(true, (root) => {
      const directory = join(root, projectId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      directoryExists(directory);
      const filename = join(directory, noteId + ".md");
      const previous = read(filename, projectId, noteId)?.note;
      if (previous !== undefined) {
        if (previous.title !== title || previous.body !== body || previous.kind !== kind || previous.verification !== verification
          || JSON.stringify(previous.relatedNoteIds) !== JSON.stringify(relatedNoteIds)) {
          throw new MemoryError("identity_conflict", "This note ID already records different content.");
        }
        return { write: "duplicate", note: previous };
      }
      for (const id of relatedNoteIds) {
        if (!read(join(directory, id + ".md"), projectId, id)) {
          throw new MemoryError("not_found", "A related note is unavailable in this project.");
        }
      }
      const metadata: Metadata = { version: 1, kind, createdAt: new Date().toISOString(), verification, relatedNoteIds };
      const markdown = frontMatter + JSON.stringify(metadata) + contentDivider + title + "\n\n" + body + relatedLinks(relatedNoteIds) + "\n";
      const temporary = join(directory, `.praxis-${randomUUID()}.tmp`);
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        try { writeFileSync(descriptor, markdown, { flush: true }); } finally { closeSync(descriptor); }
        // Publish a complete file without replacing any existing note, including manually created files.
        linkSync(temporary, filename);
      } catch (error) {
        if (errorCode(error, "EEXIST")) throw new MemoryError("identity_conflict", "This note ID already exists.");
        throw error;
      } finally { unlinkSync(temporary); }
      return { write: "inserted", note: decode(markdown, projectId, noteId)! };
    });
    if (!outcome) throw new MemoryError("unavailable", "The configured memory directory is unavailable.");
    return outcome;
  }

  retrieve({ projectId, noteId, query, limit }: z.infer<typeof retrieveMemorySchema>) {
    const directory = join(this.#directory, projectId);
    if (!directoryExists(this.#directory) || !directoryExists(directory)) return { notes: [] };
    if (noteId !== undefined) {
      const note = read(join(directory, noteId + ".md"), projectId, noteId)?.note;
      return { notes: note ? [note] : [] };
    }
    const term = query?.toLowerCase();
    const notes = listProject(this.#directory, projectId).map(({ note }) => note)
      .filter(({ title, body, verification }) => term === undefined || [title, body, verification].some(
        (text) => text?.toLowerCase().includes(term),
      )).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    return { notes: notes.slice(0, limit) };
  }

  async export(destination: string) {
    const output = resolve(destination);
    const parent = realpathSync(dirname(output));
    if (within(this.#directory, output)) throw new MemoryError("unavailable", "Export to a new directory outside the memory vault.");
    const outcome = await this.#serialize(false, (root) => {
      if (within(root, parent)) throw new MemoryError("unavailable", "Export to a new directory outside the memory vault.");
      const records = listVault(root);
      mkdirSync(output, { mode: 0o700 });
      const files: string[] = [];
      const directories = new Set<string>();
      try {
        for (const { note, bytes } of records) {
          const path = join(output, note.relativePath);
          const directory = dirname(path);
          if (!directories.has(directory)) {
            mkdirSync(directory, { mode: 0o700 });
            directories.add(directory);
          }
          const descriptor = openSync(path, "wx", 0o600);
          files.push(path);
          try { writeFileSync(descriptor, bytes); } finally { closeSync(descriptor); }
        }
      } catch (error) {
        for (const file of files) { try { unlinkSync(file); } catch {} }
        for (const directory of directories) { try { rmdirSync(directory); } catch {} }
        try { rmdirSync(output); } catch {}
        throw error;
      }
      return { exported: records.length };
    });
    if (outcome) return outcome;
    mkdirSync(output, { mode: 0o700 });
    return { exported: 0 };
  }

  async prune(before: string) {
    const cutoff = z.iso.date().parse(before);
    return await this.#serialize(false, (root) => {
      const expired = listVault(root).filter(({ note }) => note.createdAt.slice(0, 10) < cutoff);
      for (const { path } of expired) unlinkSync(path);
      return { removed: expired.length };
    }) ?? { removed: 0 };
  }

  async #serialize<T>(create: boolean, operation: (root: string) => T): Promise<T | undefined> {
    if (create) mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    if (!directoryExists(this.#directory)) return;
    const root = realpathSync(this.#directory);
    const lockPath = join(root, ".praxis-memory.lock");
    // SQLite arbitrates a cross-process writer lock. Note data lives only in Markdown.
    const descriptor = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!fstatSync(descriptor).isFile()) throw new MemoryError("unavailable", "The memory writer lock is unavailable.");
    } finally { closeSync(descriptor); }
    const lock = new DatabaseSync(lockPath, { timeout: 0 });
    const deadline = performance.now() + 5_000;
    try {
      for (;;) {
        try {
          lock.exec("BEGIN IMMEDIATE");
          break;
        } catch (error) {
          if (!(error instanceof Error && "errcode" in error && error.errcode === sqliteBusy)) throw error;
          if (performance.now() >= deadline) throw new MemoryError("unavailable", "The project memory writer is busy.");
          await delay(25);
        }
      }
      const result = operation(root);
      lock.exec("COMMIT");
      return result;
    } finally { lock.close(); }
  }
}
