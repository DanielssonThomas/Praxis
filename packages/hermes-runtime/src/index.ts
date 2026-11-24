import { createHash } from "node:crypto";
import {
  contractVersion,
  runtimeOutputLimit,
  runtimeSessionStatusSchema,
  sessionIdSchema,
  sessionSchema,
  taskIdSchema,
} from "@praxis/contracts";
import type { RuntimeOutput, RuntimeSessionSnapshot, RuntimeSessionStatus } from "@praxis/contracts";
import { z } from "zod";

const runId = z.string().regex(/^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const hermesAssignmentSchema = z.strictObject({
  schemaVersion: z.literal(contractVersion),
  taskId: taskIdSchema,
  sessionId: sessionIdSchema,
  runId,
});
export type HermesAssignment = z.infer<typeof hermesAssignmentSchema>;

const nativeCapabilitiesSchema = z.object({
  platform: z.literal("hermes-agent"),
  auth: z.object({ type: z.literal("bearer"), required: z.literal(true) }),
  features: z.record(z.string(), z.unknown()),
});
const receiptSchema = z.object({
  run_id: runId,
  session_id: z.string(),
  status: z.string(),
  output: z.string().nullish(),
});
const creationSchema = z.object({ run_id: runId });
const stopSchema = z.object({ run_id: runId.optional(), status: z.string() });
const promptSchema = z.string().refine((text) => text.trim().length > 0);

type Capability = { available: true } | { available: false; reason: string };
export interface HermesCapabilities {
  submission: Capability;
  inspection: Capability;
  stop: Capability;
  liveOutput: Capability;
  kanban: Capability;
}

type RuntimeErrorCode =
  | "invalid_input"
  | "invalid_response"
  | "unauthorized"
  | "unsupported"
  | "assignment_mismatch"
  | "not_found"
  | "native_refused"
  | "unavailable";

export class HermesRuntimeError extends Error {
  constructor(readonly code: RuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HermesRuntimeError";
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: "invalid_input" | "invalid_response", message: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new HermesRuntimeError(code, message);
}

function urlForOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HermesRuntimeError("invalid_input", "Set Hermes to an explicit loopback HTTP origin.");
  }
  if (!["http:", "https:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.pathname !== "/"
    || url.username || url.password || url.search || url.hash) {
    throw new HermesRuntimeError("invalid_input", "Set Hermes to an explicit loopback HTTP origin without embedded credentials.");
  }
  return url;
}

function nativeSessionFor(taskId: string, sessionId: string): string {
  return `praxis-${createHash("sha256").update(taskId).update("\0").update(sessionId).digest("hex")}`;
}

function nativeFeature(features: Record<string, unknown>, name: string): Capability {
  return features[name] === true
    ? { available: true }
    : { available: false, reason: `Hermes does not advertise ${name}.` };
}

function requireCapability(capability: Capability): void {
  if (!capability.available) throw new HermesRuntimeError("unsupported", capability.reason);
}

function normalizeStatus(status: string): RuntimeSessionStatus {
  if (status === "cancelled") return "stopped";
  if (status === "started") return "running";
  const normalized = runtimeSessionStatusSchema.safeParse(status);
  return normalized.success ? normalized.data : "unknown";
}

function normalizeOutput(text: string | null | undefined): RuntimeOutput {
  if (!text) {
    return { availability: "unavailable", reason: "The Hermes run receipt does not contain output." };
  }
  const truncated = text.length > runtimeOutputLimit;
  const tail = truncated ? text.slice(-runtimeOutputLimit).replace(/^[\uDC00-\uDFFF]/, "") : text;
  return { availability: "available", text: tail, truncated };
}

export class HermesRuntime {
  readonly #origin: URL;
  readonly #apiKey: string;

  constructor(options: { origin: string; apiKey: string }) {
    this.#origin = urlForOrigin(options.origin);
    if (typeof options.apiKey !== "string" || !/^[!-~]+$/.test(options.apiKey)) {
      throw new HermesRuntimeError("invalid_input", "Supply a Hermes bearer credential outside the Praxis settings file.");
    }
    this.#apiKey = options.apiKey;
  }

  async capabilities(): Promise<HermesCapabilities> {
    const response = await this.#request("/v1/capabilities");
    const { features } = parse(nativeCapabilitiesSchema, response, "invalid_response",
      "Hermes did not report an authenticated API capabilities document.");
    return {
      submission: nativeFeature(features, "run_submission"),
      inspection: nativeFeature(features, "run_status"),
      stop: nativeFeature(features, "run_stop"),
      liveOutput: { available: false, reason: "The adapter reads run receipts. Live stream attachment is unavailable." },
      kanban: { available: false, reason: "The Runs API has no Kanban board control." },
    };
  }

  async createAssignment(sessionValue: unknown, promptValue: unknown): Promise<HermesAssignment> {
    const session = parse(sessionSchema, sessionValue, "invalid_input", "Supply a valid Praxis session.");
    const prompt = parse(promptSchema, promptValue, "invalid_input", "Supply a nonblank assignment prompt.");
    requireCapability((await this.capabilities()).submission);

    const nativeSession = nativeSessionFor(session.taskId, session.id);
    const receipt = await this.#request("/v1/runs", {
      method: "POST",
      headers: { "Idempotency-Key": nativeSession },
      body: JSON.stringify({ input: prompt, session_id: nativeSession }),
    });
    const { run_id } = parse(creationSchema, receipt, "invalid_response", "Hermes did not return a native run ID.");
    return { schemaVersion: contractVersion, taskId: session.taskId, sessionId: session.id, runId: run_id };
  }

  async inspectAssignment(value: unknown): Promise<RuntimeSessionSnapshot> {
    const assignment = parse(hermesAssignmentSchema, value, "invalid_input", "Supply a valid Hermes assignment reference.");
    requireCapability((await this.capabilities()).inspection);
    return this.#readRun(assignment);
  }

  async stopAssignment(value: unknown, authorize?: () => Promise<void>): Promise<RuntimeSessionSnapshot> {
    const assignment = parse(hermesAssignmentSchema, value, "invalid_input", "Supply a valid Hermes assignment reference.");
    const { inspection, stop } = await this.capabilities();
    requireCapability(stop);
    requireCapability(inspection);

    const state = await this.#readRun(assignment);
    if (state.status === "unknown") {
      throw new HermesRuntimeError("unsupported", "Hermes did not report a controllable run state.");
    }
    if (state.status !== "queued" && state.status !== "running" && state.status !== "waiting_for_approval") return state;

    await authorize?.();
    const receipt = await this.#request(`/v1/runs/${assignment.runId}/stop`, { method: "POST" });
    const stopped = parse(stopSchema, receipt, "invalid_response", "Hermes did not acknowledge the stop request.");
    if (stopped.run_id !== undefined && stopped.run_id !== assignment.runId) {
      throw new HermesRuntimeError("assignment_mismatch", "Hermes acknowledged a different run.");
    }
    if (stopped.status === "stopping") return { ...state, status: "stopping" };
    return this.#readRun(assignment);
  }

  async #readRun(assignment: HermesAssignment): Promise<RuntimeSessionSnapshot> {
    const value = await this.#request(`/v1/runs/${assignment.runId}`);
    const receipt = parse(receiptSchema, value, "invalid_response", "Hermes returned an invalid run receipt.");
    if (receipt.run_id !== assignment.runId || receipt.session_id !== nativeSessionFor(assignment.taskId, assignment.sessionId)) {
      throw new HermesRuntimeError("assignment_mismatch", "The Hermes run does not match the Praxis assignment.");
    }
    return {
      schemaVersion: contractVersion,
      taskId: assignment.taskId,
      sessionId: assignment.sessionId,
      status: normalizeStatus(receipt.status),
      output: normalizeOutput(receipt.output),
    };
  }

  async #request(path: string, options: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.#apiKey}`);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");

    let response: Response;
    try {
      response = await fetch(new URL(path, this.#origin), {
        ...options,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new HermesRuntimeError("unavailable", "Could not reach the local Hermes API.", { cause: error });
    }

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new HermesRuntimeError("unauthorized", "Hermes refused the configured bearer credential or its scope.");
      }
      if (response.status === 404) {
        throw new HermesRuntimeError("not_found", "The requested Hermes run or API route is unavailable.");
      }
      const code = response.status >= 500 || response.status === 429 ? "unavailable" : "native_refused";
      throw new HermesRuntimeError(code, `Hermes refused the API request (HTTP ${response.status}).`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new HermesRuntimeError("invalid_response", "Hermes did not return a JSON response.", { cause: error });
    }
  }
}
