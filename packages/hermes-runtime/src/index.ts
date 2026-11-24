import { createHash } from "node:crypto";
import {
  contractVersion,
  runtimeOutputLimit,
  runtimeSessionStatusSchema,
  sessionIdSchema,
  sessionSchema,
  taskIdSchema,
  usageSchema,
} from "@praxis/contracts";
import type { RuntimeOutput, RuntimeSessionSnapshot, RuntimeSessionStatus, Usage } from "@praxis/contracts";
import { createParser } from "eventsource-parser";
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
  usage: z.unknown().optional(),
});
const nativeUsageSchema = z.object({
  input_tokens: z.int().nonnegative().optional(),
  output_tokens: z.int().nonnegative().optional(),
});
const nativeStreamEvent = z.object({
  event: z.string(),
  run_id: runId,
  seq: z.int().nonnegative().optional(),
  delta: z.unknown().optional(),
  output: z.unknown().optional(),
});
const creationSchema = z.object({ run_id: runId });
const stopSchema = z.object({ run_id: runId.optional(), status: z.string() });
const promptSchema = z.string().refine((text) => text.trim().length > 0);
export const manualGuidanceSchema = z.string().trim().min(1).max(1_000);
const steerSchema = z.object({ run_id: runId, accepted: z.literal(true) });
const transcriptPageSize = 100;
const transcriptSchema = z.object({
  session_id: z.string(),
  pagination: z.object({
    limit: z.int().positive(), offset: z.int().nonnegative(), order: z.literal("latest"), returned: z.int().nonnegative(),
  }),
  data: z.array(z.object({
    id: z.int().positive(), role: z.string(), content: z.unknown(), display_kind: z.string().nullish(),
  })).max(transcriptPageSize),
});
const steerOpen = "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]\n";
const steerClose = "\n[/OUT-OF-BAND USER MESSAGE]";

type Capability = { available: true } | { available: false; reason: string };
export interface HermesCapabilities {
  submission: Capability;
  inspection: Capability;
  stop: Capability;
  liveOutput: Capability;
  manualGuidance: Capability;
  kanban: Capability;
}

export interface HermesOutputCursor {
  runId: string;
  seq: number;
  output: RuntimeOutput;
  truncated: boolean;
}

interface RunInspection {
  snapshot: RuntimeSessionSnapshot;
  usage: Usage;
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

function normalizeUsage(value: unknown, assignment: HermesAssignment): Usage {
  const observed = nativeUsageSchema.safeParse(value);
  const identity = {
    schemaVersion: contractVersion,
    id: `usage_${createHash("sha256").update(assignment.sessionId).update("\0").update(assignment.runId).digest("hex")}`,
    sessionId: assignment.sessionId,
  };
  if (observed.success && (observed.data.input_tokens !== undefined || observed.data.output_tokens !== undefined)) {
    return usageSchema.parse({
      ...identity, metering: "reported",
      inputTokens: observed.data.input_tokens, outputTokens: observed.data.output_tokens,
    });
  }
  return usageSchema.parse({ ...identity, metering: "unknown", reason: "Hermes has not reported usage for this run." });
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
      liveOutput: nativeFeature(features, "run_events_sse"),
      manualGuidance: features.run_steer === true
        ? nativeFeature(features, "session_resources") : nativeFeature(features, "run_steer"),
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
    return (await this.#readRun(assignment)).snapshot;
  }

  async inspectLiveAssignment(value: unknown, previous?: HermesOutputCursor): Promise<RunInspection & { cursor?: HermesOutputCursor }> {
    const assignment = parse(hermesAssignmentSchema, value, "invalid_input", "Supply a valid Hermes assignment reference.");
    const capabilities = await this.capabilities();
    requireCapability(capabilities.inspection);
    const inspected = await this.#readRun(assignment);
    const { snapshot } = inspected;
    if (snapshot.status !== "queued" && snapshot.status !== "running" && snapshot.status !== "waiting_for_approval"
      && snapshot.status !== "stopping") {
      if (snapshot.output.availability === "unavailable" && previous?.runId === assignment.runId
        && previous.output.availability === "available") {
        return { ...inspected, snapshot: { ...snapshot, output: previous.output }, cursor: previous };
      }
      return inspected;
    }
    if (!capabilities.liveOutput.available) {
      return snapshot.output.availability === "available" ? inspected : {
        ...inspected,
        snapshot: { ...snapshot, output: { availability: "unavailable", reason: capabilities.liveOutput.reason } },
      };
    }
    const cursor = await this.#readLiveOutput(assignment, previous);
    return {
      ...inspected,
      snapshot: { ...snapshot, output: cursor.output.availability === "available" ? cursor.output
        : snapshot.output.availability === "available" ? snapshot.output : cursor.output },
      cursor,
    };
  }

  async stopAssignment(value: unknown, authorize?: () => Promise<void>): Promise<RuntimeSessionSnapshot> {
    const assignment = parse(hermesAssignmentSchema, value, "invalid_input", "Supply a valid Hermes assignment reference.");
    const { inspection, stop } = await this.capabilities();
    requireCapability(stop);
    requireCapability(inspection);

    const { snapshot: state } = await this.#readRun(assignment);
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
    return (await this.#readRun(assignment)).snapshot;
  }

  async guidanceReady(value: unknown): Promise<boolean> {
    const assignment = parse(hermesAssignmentSchema, value, "invalid_input", "Supply a valid Hermes assignment reference.");
    const { inspection, manualGuidance } = await this.capabilities();
    if (!inspection.available || !manualGuidance.available) return false;
    return (await this.#readRun(assignment)).snapshot.status === "running";
  }

  async guidanceBaseline(value: unknown): Promise<number> {
    const assignment = parse(hermesAssignmentSchema, value, "invalid_input", "Supply a valid Hermes assignment reference.");
    if (!await this.guidanceReady(assignment)) {
      throw new HermesRuntimeError("unsupported", "Hermes is not accepting guidance for this run.");
    }
    return (await this.#readTranscript(assignment, 1)).at(-1)?.id ?? 0;
  }

  async steerAssignment(value: unknown, textValue: unknown, authorize: () => Promise<void>): Promise<void> {
    const assignment = parse(hermesAssignmentSchema, value, "invalid_input", "Supply a valid Hermes assignment reference.");
    const text = parse(manualGuidanceSchema, textValue, "invalid_input", "Supply nonblank operator guidance.");
    if (!await this.guidanceReady(assignment)) {
      throw new HermesRuntimeError("unsupported", "Hermes is not accepting guidance for this run.");
    }
    await authorize();
    const response = await this.#request(`/v1/runs/${assignment.runId}/steer`, {
      method: "POST", body: JSON.stringify({ input: text }),
    });
    const accepted = parse(steerSchema, response, "invalid_response", "Hermes did not identify an accepted guidance request.");
    if (accepted.run_id !== assignment.runId) {
      throw new HermesRuntimeError("assignment_mismatch", "Hermes acknowledged guidance on another run.");
    }
  }

  async reconcileGuidance(value: unknown, after: number, textDigest: string): Promise<"delivered" | "recorded" | undefined> {
    const assignment = parse(hermesAssignmentSchema, value, "invalid_input", "Supply a valid Hermes assignment reference.");
    const { snapshot } = await this.#readRun(assignment);
    const terminal = ["completed", "failed", "stopped", "interrupted"].includes(snapshot.status);
    const deadline = AbortSignal.timeout(20_000);
    let boundary: string | undefined;
    for (let offset = 0; ; offset += transcriptPageSize - 1) {
      const rows = await this.#readTranscript(assignment, transcriptPageSize, offset, deadline);
      if (boundary !== undefined && JSON.stringify(rows.at(-1)) !== boundary) {
        throw new HermesRuntimeError("unavailable", "The Hermes transcript changed during verification. Try again.");
      }
      for (const row of rows) {
        if (row.id <= after || row.role !== "user" || typeof row.content !== "string") continue;
        const delivered = row.display_kind === "steer" && row.content.startsWith(steerOpen) && row.content.endsWith(steerClose);
        if (!delivered && !terminal) continue;
        const text = delivered ? row.content.slice(steerOpen.length, -steerClose.length) : row.content;
        if (createHash("sha256").update(text).digest("hex") === textDigest) return delivered ? "delivered" : "recorded";
      }
      if (rows.length < transcriptPageSize || rows[0].id <= after) return;
      boundary = JSON.stringify(rows[0]);
    }
  }

  async #readTranscript(assignment: HermesAssignment, limit: number, offset = 0, signal?: AbortSignal) {
    const session = nativeSessionFor(assignment.taskId, assignment.sessionId);
    const response = await this.#request(
      `/api/sessions/${session}/messages?limit=${limit}&offset=${offset}&order=latest&include_compacted=true`, { signal },
    );
    const transcript = parse(transcriptSchema, response, "invalid_response", "Hermes did not return a usable transcript.");
    if (transcript.session_id !== session) {
      throw new HermesRuntimeError("assignment_mismatch", "The Hermes transcript does not match the exact Praxis session.");
    }
    const { pagination, data } = transcript;
    if (pagination.limit !== limit || pagination.offset !== offset || pagination.returned !== data.length
      || data.length > limit || data.some(({ id }, index) => index > 0 && id <= data[index - 1].id)) {
      throw new HermesRuntimeError("invalid_response", "Hermes did not return a usable transcript page.");
    }
    return data;
  }

  async #readRun(assignment: HermesAssignment): Promise<RunInspection> {
    const value = await this.#request(`/v1/runs/${assignment.runId}`);
    const receipt = parse(receiptSchema, value, "invalid_response", "Hermes returned an invalid run receipt.");
    if (receipt.run_id !== assignment.runId || receipt.session_id !== nativeSessionFor(assignment.taskId, assignment.sessionId)) {
      throw new HermesRuntimeError("assignment_mismatch", "The Hermes run does not match the Praxis assignment.");
    }
    return {
      snapshot: {
        schemaVersion: contractVersion,
        taskId: assignment.taskId,
        sessionId: assignment.sessionId,
        status: normalizeStatus(receipt.status),
        output: normalizeOutput(receipt.output),
      },
      usage: normalizeUsage(receipt.usage, assignment),
    };
  }

  async #readLiveOutput(assignment: HermesAssignment, previous?: HermesOutputCursor): Promise<HermesOutputCursor> {
    const cursor: HermesOutputCursor = previous?.runId === assignment.runId ? previous : {
      runId: assignment.runId,
      seq: -1,
      truncated: false,
      output: { availability: "unavailable", reason: "Hermes has not published live output." },
    };
    let seq = cursor.seq;
    let output = cursor.output;
    let truncated = cursor.truncated;
    const parser = createParser({
      onEvent(frame) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(frame.data);
        } catch {
          throw new HermesRuntimeError("invalid_response", "Hermes returned a malformed stream event.");
        }
        const event = parse(nativeStreamEvent, decoded, "invalid_response", "Hermes returned an invalid stream event.");
        if (event.run_id !== assignment.runId) {
          throw new HermesRuntimeError("assignment_mismatch", "A Hermes stream event belongs to another run.");
        }
        if (event.event === "replay.truncated") {
          truncated = true;
          if (output.availability === "available") output = { ...output, truncated: true };
          return;
        }
        if (event.seq === undefined || event.seq <= seq) return;
        seq = event.seq;
        if (event.event === "message.delta" && typeof event.delta === "string") {
          const prefix = output.availability === "available" ? output.text : "";
          output = normalizeOutput(prefix + event.delta);
          if (output.availability === "available") {
            truncated ||= output.truncated;
            if (truncated) output = { ...output, truncated: true };
          }
        } else if (event.event === "run.completed" && typeof event.output === "string") {
          output = normalizeOutput(event.output);
          truncated = output.availability === "available" && output.truncated;
        }
      },
    });
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (seq >= 0) headers["Last-Event-ID"] = String(seq);
    const signal = AbortSignal.timeout(350);
    try {
      const response = await this.#response(`/v1/runs/${assignment.runId}/events`, { headers, signal });
      if (!response.headers.get("content-type")?.startsWith("text/event-stream") || response.body === null) {
        await response.body?.cancel();
        throw new HermesRuntimeError("invalid_response", "Hermes did not provide a run event stream.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.feed(decoder.decode());
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (error instanceof HermesRuntimeError && error.code === "not_found") {
        if (output.availability === "unavailable") {
          output = { availability: "unavailable", reason: "The native Hermes stream is unavailable or its replay buffer expired." };
        }
      } else if (!signal.aborted || (error instanceof HermesRuntimeError
        && (error.code === "assignment_mismatch" || error.code === "invalid_response"))) {
        throw error;
      }
    }
    return { runId: assignment.runId, seq, output, truncated };
  }

  async #response(path: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${this.#apiKey}`);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");

    let response: Response;
    try {
      response = await fetch(new URL(path, this.#origin), {
        ...options,
        headers,
        redirect: "error",
        signal: options.signal ?? AbortSignal.timeout(10_000),
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
    return response;
  }

  async #request(path: string, options: RequestInit = {}): Promise<unknown> {
    const response = await this.#response(path, options);
    try {
      return await response.json();
    } catch (error) {
      throw new HermesRuntimeError("invalid_response", "Hermes did not return a JSON response.", { cause: error });
    }
  }
}
