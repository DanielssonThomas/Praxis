import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { arch, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  contractVersion, usageSchema, workerAssignmentRequestSchema, workerAssignmentSchema,
} from "@praxis/contracts";
import type {
  WorkerAssignment, WorkerAssignmentRequest, WorkerCapabilities, WorkerExecutor, WorkerObservation,
} from "@praxis/contracts";
import { loadAxiom } from "./axiom.js";
import { stageCuratedSkills } from "./curated-skills.js";
import type { CodexSkillResource } from "./curated-skills.js";
import { CodexRun } from "./native.js";

const execute = promisify(execFile);
export const supportedCodexVersion = "0.172.0-alpha.2";
const maxTimeout = 2_147_483_647;
const available = new Set(["process-execution", "policy-loading", "live-output", "cancellation", "completion"]);
const networkEnvironment = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];

interface Staging {
  workspace: string;
  codexHome: string;
  userHome: string;
  task: WorkerAssignmentRequest["task"];
  session: WorkerAssignmentRequest["session"];
  signal: AbortSignal;
}

export interface CodexExecutorOptions {
  program: string;
  axiomRoot: string;
  root: string;
  model: string;
  workspaceOnly?: boolean;
  prepareWorkspace?: (scope: Staging) => Promise<void>;
  prepareProfile?: (scope: Staging) => Promise<void>;
  selectedSkills?: (scope: Pick<Staging, "task" | "session" | "signal">) => Promise<readonly CodexSkillResource[]>;
  authorizeLaunch?: (scope: Staging) => Promise<void>;
}

type ErrorCode = "invalid_input" | "unsupported" | "assignment_mismatch" | "not_found" | "unavailable";
export class CodexExecutorError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexExecutorError";
  }
}

interface Entry {
  assignment: WorkerAssignment;
  run: CodexRun;
  workspace: string;
  closed: Promise<void>;
}

function environment(): Record<string, string> {
  return Object.fromEntries(["PATH", ...networkEnvironment].flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

export class CodexExecutor implements WorkerExecutor {
  readonly #options: CodexExecutorOptions;
  readonly #assignments = new Map<string, Entry>();
  readonly #sessions = new Set<string>();
  readonly #tasks = new Map<string, { attempts: number; active: number; maxAttempts: number; maxConcurrency: number }>();
  #axiom?: ReturnType<typeof loadAxiom>;

  constructor(options: CodexExecutorOptions) {
    if (!isAbsolute(options.program) || !isAbsolute(options.root) || !isAbsolute(options.axiomRoot)
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(options.model)) {
      throw new CodexExecutorError("invalid_input", "Supply absolute local paths and a valid Codex model identifier.");
    }
    this.#options = { ...options };
  }

  async capabilities(): Promise<WorkerCapabilities> {
    const host: WorkerCapabilities["host"] = { runtime: "codex", os: platform(), architecture: arch(), surface: "cli" };
    let reason: string | undefined;
    if (host.os !== "linux" || host.architecture !== "x64") reason = "Codex workers support Linux x64.";
    else {
      try {
        const result = await execute(this.#options.program, ["--version"], { timeout: 5_000, env: environment() });
        host.version = /^codex-cli (\S+)\s*$/.exec(result.stdout)?.[1];
      } catch {
        reason = "The configured Codex CLI is unavailable.";
      }
      if (reason === undefined && host.version !== supportedCodexVersion) reason = `Expected Codex CLI ${supportedCodexVersion}.`;
    }
    const value = reason === undefined ? { available: true as const } : { available: false as const, reason };
    return { host, launch: value, output: value, cancellation: value, completion: value };
  }

  async createAssignment(value: unknown): Promise<WorkerAssignment> {
    const parsed = workerAssignmentRequestSchema.safeParse(value);
    if (!parsed.success) throw new CodexExecutorError("invalid_input", "Supply a matching task, session and worker brief.");
    const { task, session } = parsed.data;
    const { launch } = await this.capabilities();
    if (!launch.available) throw new CodexExecutorError("unsupported", launch.reason);
    let axiom: Awaited<ReturnType<typeof loadAxiom>>;
    try {
      axiom = await (this.#axiom ??= loadAxiom(this.#options.axiomRoot));
    } catch (cause) {
      this.#axiom = undefined;
      throw new CodexExecutorError("unavailable", "A clean built checkout of the pinned Axiom revision is required.", { cause });
    }

    let brief;
    try { brief = axiom.parse(parsed.data.brief); } catch {
      throw new CodexExecutorError("invalid_input", "The worker brief does not satisfy the pinned Axiom contract.");
    }
    if (brief.id !== task.id || brief.limits.timeoutMs > maxTimeout
      || brief.ownedPaths.some((path) => path.includes("\\") || path.split("/").some((part) => part === ".." || part === ""))) {
      throw new CodexExecutorError("invalid_input", "The brief must bind this task, a supported timeout and relative workspace scope.");
    }
    if (brief.policy.profiles.length !== 0 || brief.requiredCapabilities.some((item) => !available.has(item))) {
      throw new CodexExecutorError("unsupported", "This worker supports core-only Axiom policy and direct CLI execution capabilities.");
    }

    const { maxAttempts, maxConcurrency, timeoutMs } = brief.limits;
    const limits = this.#tasks.get(task.id) ?? { attempts: 0, active: 0, maxAttempts, maxConcurrency };
    if (limits.maxAttempts !== maxAttempts || limits.maxConcurrency !== maxConcurrency
      || limits.attempts >= maxAttempts || limits.active >= maxConcurrency || this.#sessions.has(session.id)) {
      throw new CodexExecutorError("invalid_input", "The assignment exceeds its task limits or the session already owns a worker.");
    }
    this.#sessions.add(session.id);
    this.#tasks.set(task.id, limits);
    limits.attempts++;
    limits.active++;
    const deadline = performance.now() + timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    let directory: string | undefined;
    let run: CodexRun | undefined;
    try {
      const root = resolve(this.#options.root);
      await mkdir(root, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(root, "codex-"));
      const workspace = join(directory, "workspace");
      const codexHome = join(directory, "codex");
      const userHome = join(directory, "home");
      const privatePaths = [codexHome, userHome, join(directory, "bundle")];
      await Promise.all([workspace, codexHome, userHome].map((path) => mkdir(path, { mode: 0o700 })));
      const staging = { workspace, codexHome, userHome, task, session, signal };
      await this.#options.prepareWorkspace?.(staging);
      await this.#options.prepareProfile?.(staging);
      if (this.#options.selectedSkills) {
        const selected = await this.#options.selectedSkills({ task, session, signal });
        await stageCuratedSkills(userHome, selected, signal);
      }
      signal.throwIfAborted();
      const profile = { program: this.#options.program, workspace, home: codexHome, userHome, environment: environment() };
      await axiom.prepare(profile, brief, privatePaths[2], signal);
      signal.throwIfAborted();
      await this.#options.authorizeLaunch?.(staging);
      signal.throwIfAborted();
      const assignment = workerAssignmentSchema.parse({
        schemaVersion: contractVersion, taskId: task.id, sessionId: session.id, runtime: "codex", runId: `worker_${randomUUID()}`,
      });
      run = new CodexRun(profile, this.#options.model, `Axiom scoped task brief supplied by the caller:\n${JSON.stringify(brief)}`,
        deadline - performance.now(), this.#options.workspaceOnly);
      await run.started;
      const closed = run.finished.then(async () => {
        limits.active--;
        await Promise.all(privatePaths.map((path) => rm(path, { recursive: true, force: true })));
      });
      void closed.catch(() => {});
      this.#assignments.set(assignment.runId, { assignment: { ...assignment }, run, workspace, closed });
      return assignment;
    } catch (cause) {
      if (run !== undefined) {
        run.stop();
        await run.finished;
      }
      limits.active--;
      limits.attempts--;
      this.#sessions.delete(session.id);
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      throw new CodexExecutorError("unavailable", "Codex could not stage or launch the scoped assignment.", { cause });
    }
  }

  inspectAssignment(value: unknown): WorkerObservation {
    const { assignment, run } = this.#entry(value);
    const { schemaVersion, taskId, sessionId } = assignment;
    const identity = { schemaVersion, sessionId, id: `usage_${assignment.runId}` };
    return {
      snapshot: { schemaVersion, taskId, sessionId, status: run.status, output: { ...run.output } },
      usage: usageSchema.parse(run.usage === undefined
        ? { ...identity, metering: "unknown", reason: "Codex has not reported validated completion usage." }
        : { ...identity, metering: "reported", inputTokens: run.usage.input_tokens, outputTokens: run.usage.output_tokens }),
    };
  }

  stopAssignment(value: unknown): WorkerObservation {
    this.#entry(value).run.stop();
    return this.inspectAssignment(value);
  }

  async waitAssignment(value: unknown): Promise<WorkerObservation> {
    const { assignment, closed } = this.#entry(value);
    try { await closed; } catch {
      throw new CodexExecutorError("unavailable", "Codex settled but its temporary profile cleanup failed.");
    }
    return this.inspectAssignment(assignment);
  }

  workspaceFor(value: unknown): string {
    return this.#entry(value).workspace;
  }

  #entry(value: unknown): Entry {
    const parsed = workerAssignmentSchema.safeParse(value);
    if (!parsed.success) throw new CodexExecutorError("invalid_input", "Supply a valid assignment reference.");
    const entry = this.#assignments.get(parsed.data.runId);
    if (entry === undefined) throw new CodexExecutorError("not_found", "This host does not own that Codex assignment.");
    if (entry.assignment.taskId !== parsed.data.taskId || entry.assignment.sessionId !== parsed.data.sessionId
      || parsed.data.runtime !== "codex") {
      throw new CodexExecutorError("assignment_mismatch", "The Codex assignment does not match the exact task and session.");
    }
    return entry;
  }
}
