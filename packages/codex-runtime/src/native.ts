import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { runtimeOutputLimit } from "@praxis/contracts";
import type { RuntimeOutput, RuntimeSessionStatus } from "@praxis/contracts";
import { z } from "zod";
import type { AxiomProfile } from "./axiom.js";

const stdoutLimit = 8 * 1024 * 1024;
const nativeEvent = z.object({ type: z.string(), item: z.unknown().optional(), usage: z.unknown().optional() });
const message = z.object({ type: z.literal("agent_message"), text: z.string() });
const usageSchema = z.object({ input_tokens: z.int().nonnegative(), output_tokens: z.int().nonnegative() });
const workspaceOnlyConfig = [
  "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
  "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
  "-c", "sandbox_workspace_write.writable_roots=[]",
  "-c", "sandbox_workspace_write.network_access=false",
];
type NativeUsage = z.infer<typeof usageSchema>;
type StopReason = "operator" | "deadline" | "output";

export class CodexRun {
  status: RuntimeSessionStatus = "queued";
  output: RuntimeOutput = { availability: "unavailable", reason: "Codex has not emitted a message." };
  usage?: NativeUsage;
  readonly started: Promise<void>;
  readonly finished: Promise<void>;
  readonly #child: ChildProcessWithoutNullStreams;
  #interruption?: StopReason;
  #deadline?: NodeJS.Timeout;
  #forceStop?: NodeJS.Timeout;
  #pending = "";
  #characters = 0;
  #terminal?: "completed" | "failed";
  #malformed = false;

  constructor(profile: AxiomProfile, model: string, prompt: string, remainingMs: number, workspaceOnly = false) {
    const child = spawn(profile.program, [
      ...(workspaceOnly ? workspaceOnlyConfig : []),
      "--ask-for-approval", "never", "exec", "--sandbox", "workspace-write", "--ephemeral",
      "--skip-git-repo-check", "--color", "never", "--json", "--model", model, "-",
    ], {
      cwd: profile.workspace, detached: true,
      env: { ...profile.environment, HOME: profile.userHome, CODEX_HOME: profile.home },
      stdio: "pipe",
    });
    this.#child = child;
    this.started = new Promise((resolve, reject) => {
      child.once("spawn", () => { this.status = "running"; resolve(); });
      child.once("error", reject);
    });
    this.finished = new Promise((resolve) => child.once("close", (code, signal) => {
      clearTimeout(this.#deadline);
      clearTimeout(this.#forceStop);
      if (this.#pending.trim() !== "") this.#accept(this.#pending);
      this.#pending = "";
      if (code === 0 && this.#terminal === "completed" && !this.#malformed && this.#interruption !== "output") this.status = "completed";
      else if (this.#interruption === "operator") this.status = "stopped";
      else if (this.#interruption === "deadline" || signal !== null && this.#interruption !== "output") this.status = "interrupted";
      else this.status = "failed";
      if (this.status !== "completed") this.usage = undefined;
      resolve();
    }));
    this.#deadline = setTimeout(() => this.stop("deadline"), Math.max(1, remainingMs));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { this.#consume(chunk); });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  }

  stop(reason: StopReason = "operator"): void {
    if (this.#interruption !== undefined || (this.status !== "queued" && this.status !== "running")) return;
    this.#interruption = reason;
    this.status = "stopping";
    this.#signal("SIGTERM");
    this.#forceStop = setTimeout(() => this.#signal("SIGKILL"), 500);
  }

  #signal(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.#child.kill(signal);
    }
  }

  #consume(chunk: string): void {
    if (this.#interruption === "output") return;
    this.#characters += chunk.length;
    if (this.#characters > stdoutLimit) {
      this.stop("output");
      return;
    }
    const lines = (this.#pending + chunk).split("\n");
    this.#pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim() !== "") this.#accept(line);
  }

  #accept(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { this.#malformed = true; return; }
    const parsed = nativeEvent.safeParse(value);
    if (!parsed.success) { this.#malformed = true; return; }
    const event = parsed.data;
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      if (this.#terminal !== undefined) this.#malformed = true;
      this.#terminal = event.type === "turn.completed" ? "completed" : "failed";
      const usage = usageSchema.safeParse(event.usage);
      if (usage.success && event.type === "turn.completed") this.usage = usage.data;
    } else if (event.type === "item.completed") {
      const next = message.safeParse(event.item);
      if (!next.success || next.data.text === "") return;
      const previous = this.output;
      const combined = previous.availability === "available" ? `${previous.text}\n${next.data.text}` : next.data.text;
      this.output = {
        availability: "available",
        text: combined.slice(-runtimeOutputLimit).replace(/^[\uDC00-\uDFFF]/, ""),
        truncated: combined.length > runtimeOutputLimit || (previous.availability === "available" && previous.truncated),
      };
    }
  }
}
