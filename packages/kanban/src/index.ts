import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  contractVersion, eventSchema, githubIssueReferenceSchema, taskSchema,
} from "@praxis/contracts";
import type { GitHubIssueReference, Task, TaskId } from "@praxis/contracts";
import { OperationalStoreError } from "@praxis/state";
import type { OperationalStore } from "@praxis/state";
import { z } from "zod";

const execute = promisify(execFile);
const nativeIdSchema = z.string().regex(/^t_[0-9a-f]{8,64}$/);
const boardSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const nativeRowSchema = z.object({
  id: nativeIdSchema,
  title: z.string().min(1),
  status: z.string().min(1).max(64),
  assignee: z.string().nullish(),
});
type NativeRow = z.infer<typeof nativeRowSchema>;
type NativeTask = { nativeId: string; task: Task; status: string; assignee: string | null };
export type KanbanTask = NativeTask & { links: GitHubIssueReference[] };
export interface KanbanProjection {
  tasks: KanbanTask[];
  provider: { available: true } | { available: false; reason: string };
}
type ErrorCode = "invalid_input" | "not_found" | "unavailable" | "unauthorized" | "unsupported";

export class KanbanError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KanbanError";
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class HermesKanban {
  readonly #executable: string;
  readonly #home: string;
  readonly #board: string;

  constructor({ executable, home, board = "default" }: { executable: string; home: string; board?: string }) {
    const parsed = boardSchema.safeParse(board);
    if (!executable || !home || !parsed.success) {
      throw new KanbanError("invalid_input", "Configure a native Hermes executable, home and board slug.");
    }
    this.#executable = executable;
    this.#home = resolve(home);
    this.#board = parsed.data;
  }

  async list(): Promise<NativeTask[]> {
    const value = await this.#read(["list", "--json"]);
    const parsed = z.array(nativeRowSchema).safeParse(value);
    if (!parsed.success) throw new KanbanError("unavailable", "Hermes did not return a supported Kanban list.");
    return parsed.data.map((row) => this.#task(row));
  }

  async inspect(id: string): Promise<NativeTask | undefined> {
    if (!nativeIdSchema.safeParse(id).success) throw new KanbanError("invalid_input", "Supply a valid native task ID.");
    const value = await this.#read(["show", id, "--json"], id);
    if (value === undefined) return;
    const parsed = z.object({ task: nativeRowSchema }).safeParse(value);
    if (!parsed.success || parsed.data.task.id !== id) {
      throw new KanbanError("unavailable", "Hermes did not provide the requested Kanban task.");
    }
    return this.#task(parsed.data.task);
  }

  #task(row: NativeRow): NativeTask {
    return {
      nativeId: row.id,
      task: taskSchema.parse({
        schemaVersion: contractVersion,
        id: `task_hermes_${hash([this.#home, this.#board, row.id])}`,
        title: row.title,
      }),
      status: row.status,
      assignee: row.assignee ?? null,
    };
  }

  async #read(args: string[], taskId?: string): Promise<unknown> {
    try {
      const { stdout } = await execute(this.#executable, ["kanban", "--board", this.#board, ...args], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          HERMES_HOME: this.#home,
          HERMES_DISABLE_LAZY_INSTALLS: "1",
          HERMES_NO_SYSTEMD: "1",
          TERM: "dumb",
        },
        timeout: 8_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return JSON.parse(stdout);
    } catch (error) {
      if (taskId && error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        && error.stderr.trim() === `no such task: ${taskId}`) return undefined;
      throw new KanbanError("unavailable", "Hermes Kanban could not be read from the configured profile.", { cause: error });
    }
  }
}

const githubResponse = z.object({
  number: z.int().positive(),
  html_url: z.string(),
  pull_request: z.unknown().optional(),
});
const githubOrigin = "https://api.github.com";

export class GitHubIssueProvider {
  readonly #token: string;
  readonly #origin: string;

  constructor({ token, origin = githubOrigin }: { token: string; origin?: string }) {
    const address = URL.parse(origin);
    const allowed = address !== null && (address.origin === githubOrigin || (address.protocol === "http:" && address.hostname === "127.0.0.1"))
      && address.pathname === "/" && !address.username && !address.password && !address.search && !address.hash;
    if (!allowed || typeof token !== "string" || !/^[!-~]+$/.test(token)) {
      throw new KanbanError("invalid_input", "Configure a GitHub API credential and supported origin.");
    }
    this.#token = token;
    this.#origin = address.origin;
  }

  async verify(value: unknown): Promise<GitHubIssueReference> {
    const parsed = githubIssueReferenceSchema.safeParse(value);
    if (!parsed.success) throw new KanbanError("invalid_input", "Supply a GitHub repository and positive issue number.");
    const issue = parsed.data;

    let response: Response;
    try {
      response = await fetch(new URL(`/repos/${issue.repository}/issues/${issue.number}`, this.#origin), {
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new KanbanError("unavailable", "The GitHub issue provider cannot be reached.", { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new KanbanError("unauthorized", "GitHub did not authorize access to this issue.");
      }
      if (response.status === 404) throw new KanbanError("not_found", "GitHub could not find this issue for the configured credential.");
      throw new KanbanError("unavailable", `GitHub could not verify this issue (HTTP ${response.status}).`);
    }

    let valueFromProvider: unknown;
    try {
      valueFromProvider = await response.json();
    } catch (error) {
      throw new KanbanError("unavailable", "GitHub did not return a JSON issue receipt.", { cause: error });
    }
    const receipt = githubResponse.safeParse(valueFromProvider);
    if (!receipt.success || receipt.data.number !== issue.number || receipt.data.pull_request !== undefined
      || receipt.data.html_url.toLowerCase() !== `https://github.com/${issue.repository}/issues/${issue.number}`) {
      throw new KanbanError("unavailable", "The GitHub receipt did not identify this issue.");
    }
    return issue;
  }
}

const linkInput = githubIssueReferenceSchema.omit({ provider: true }).extend({ nativeId: nativeIdSchema });

export class KanbanBoard {
  readonly #store: OperationalStore;
  readonly #reader: Pick<HermesKanban, "list" | "inspect">;
  readonly #provider?: Pick<GitHubIssueProvider, "verify">;
  readonly #now: () => number;

  constructor(options: {
    store: OperationalStore;
    reader: Pick<HermesKanban, "list" | "inspect">;
    provider?: Pick<GitHubIssueProvider, "verify">;
    now?: () => number;
  }) {
    this.#store = options.store;
    this.#reader = options.reader;
    this.#provider = options.provider;
    this.#now = options.now ?? Date.now;
  }

  async list(): Promise<KanbanProjection> {
    const tasks = await this.#reader.list();
    return {
      tasks: tasks.map((task) => ({
        ...task,
        links: this.#store.eventsFor(task.task.id).flatMap(({ details }) => details?.type === "issue_link" ? [details.issue] : []),
      })),
      provider: this.#provider === undefined
        ? { available: false, reason: "GitHub issue linking is unavailable until a provider credential is configured." }
        : { available: true },
    };
  }

  async linkIssue(input: unknown): Promise<{ taskId: TaskId; issue: GitHubIssueReference }> {
    const parsed = linkInput.safeParse(input);
    if (!parsed.success) throw new KanbanError("invalid_input", "Supply a native task ID, GitHub repository and positive issue number.");
    if (this.#provider === undefined) throw new KanbanError("unsupported", "GitHub issue linking is unavailable.");
    const { nativeId, repository, number } = parsed.data;
    const task = await this.#reader.inspect(nativeId);
    if (task === undefined || task.status === "archived") throw new KanbanError("not_found", "The task is unavailable on the configured board.");

    const intended = { provider: "github" as const, repository, number };
    const eventId = `event_${hash([task.task.id, intended])}`;
    if (this.#hasLink(eventId, task.task.id, intended)) return { taskId: task.task.id, issue: intended };
    const verified = await this.#provider.verify(intended);
    if (verified.provider !== intended.provider || verified.repository !== repository || verified.number !== number) {
      throw new KanbanError("unavailable", "The provider returned a different issue than requested.");
    }
    const next = await this.#reader.inspect(nativeId);
    if (next?.task.id !== task.task.id || next.status === "archived") {
      throw new KanbanError("not_found", "The task is no longer available on the configured board.");
    }

    const event = eventSchema.parse({
      schemaVersion: contractVersion,
      id: eventId,
      kind: "task.issue_linked",
      subject: { kind: "task", id: task.task.id },
      occurredAt: new Date(this.#now()).toISOString(),
      details: { type: "issue_link", issue: verified },
    });
    try {
      this.#store.appendEvent(event);
    } catch (error) {
      if (!(error instanceof OperationalStoreError && error.code === "identity_conflict"
        && this.#hasLink(eventId, task.task.id, verified))) throw error;
    }
    return { taskId: task.task.id, issue: verified };
  }

  #hasLink(eventId: string, taskId: TaskId, issue: GitHubIssueReference): boolean {
    const existing = this.#store.getEvent(eventId);
    if (existing === undefined) return false;
    if (existing.subject.id !== taskId || existing.details?.type !== "issue_link"
      || existing.details.issue.repository !== issue.repository || existing.details.issue.number !== issue.number) {
      throw new KanbanError("unavailable", "The saved link identity does not match this association.");
    }
    return true;
  }
}
