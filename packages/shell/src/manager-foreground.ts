import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { ApprovalError } from "@praxis/approvals";
import { localOperatorGuard, readOperatorJson } from "@praxis/approvals/http";
import { contractVersion, sessionSchema } from "@praxis/contracts";
import type { RuntimeSessionStatus } from "@praxis/contracts";
import { HermesRuntime, HermesRuntimeError } from "@praxis/hermes-runtime";
import type { HermesAssignment, HermesOutputCursor } from "@praxis/hermes-runtime";
import { readSettings } from "@praxis/settings";
import { z } from "zod";

const route = "/api/manager/turn";
const foregroundSession = sessionSchema.parse({
  schemaVersion: contractVersion,
  taskId: "task_foreground_manager",
  id: "session_foreground_manager",
});
const requestSchema = z.strictObject({ turnId: z.string(), prompt: z.string() });
const settled = new Set<RuntimeSessionStatus>(["completed", "failed", "stopped", "interrupted", "unknown"]);

function sendError(response: ServerResponse, status: number, error: string): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ error }));
}

async function streamTurn(response: ServerResponse, runtime: HermesRuntime, assignment: HermesAssignment): Promise<void> {
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  response.once("close", disconnect);
  response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  response.flushHeaders();

  let cursor: HermesOutputCursor | undefined;
  let previous: string | undefined;
  try {
    while (!controller.signal.aborted) {
      const current = await runtime.inspectLiveAssignment(assignment, cursor);
      if (controller.signal.aborted) return;
      cursor = current.cursor;
      const record = JSON.stringify({
        kind: "snapshot", runId: assignment.runId, snapshot: current.snapshot, usage: current.usage,
      });
      if (record !== previous) {
        if (!response.write(record + "\n")) await once(response, "drain", { signal: controller.signal });
        previous = record;
      }
      if (settled.has(current.snapshot.status)) break;
      await delay(100, undefined, { signal: controller.signal });
    }
  } catch {
    if (!controller.signal.aborted) {
      response.end(JSON.stringify({ kind: "error", message: "The native manager output is unavailable." }) + "\n");
    }
  } finally {
    response.off("close", disconnect);
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

export async function managerForegroundFromEnv(settingsFile: string) {
  const origin = process.env.PRAXIS_HERMES_ORIGIN;
  const apiKey = process.env.PRAXIS_HERMES_API_KEY;
  const digest = process.env.PRAXIS_OPERATOR_TOKEN_DIGEST;
  const guard = digest ? localOperatorGuard(digest) : undefined;
  let runtime: HermesRuntime | undefined;
  if (origin && apiKey && guard) {
    // Keep the dedicated manager route off when the configured runtime is a worker or the default gateway.
    const settings = await readSettings(settingsFile).catch(() => undefined);
    const pathname = URL.parse(origin)?.pathname.replace(/\/$/, "");
    if (settings && pathname === `/p/${settings.manager.profile}` && settings.manager.profile !== "default") {
      runtime = new HermesRuntime({ origin, apiKey });
    }
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (request.url !== route) return false;
    if (!runtime || !guard) {
      sendError(response, 503, "Configure the local operator and named Hermes manager.");
      return true;
    }
    const denied = guard(request);
    if (denied) {
      sendError(response, denied.status, denied.error);
      return true;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendError(response, 405, "Submit a foreground turn with POST.");
      return true;
    }

    let assignment: HermesAssignment;
    try {
      const input = requestSchema.safeParse(await readOperatorJson(request));
      if (!input.success) {
        sendError(response, 400, "Supply a stable turn ID and prompt.");
        return true;
      }
      assignment = await runtime.submitTurn(foregroundSession, input.data.prompt, input.data.turnId);
    } catch (error) {
      if (error instanceof ApprovalError || (error instanceof HermesRuntimeError && error.code === "invalid_input")) {
        sendError(response, 400, error.message);
      } else if (error instanceof HermesRuntimeError && error.code === "native_refused" && error.message.includes("HTTP 409")) {
        sendError(response, 409, "Hermes refused this turn. Reuse the original prompt on retry.");
      } else {
        sendError(response, 503, "The native manager could not start this turn.");
      }
      return true;
    }
    if (!response.destroyed) await streamTurn(response, runtime, assignment);
    return true;
  };
}
