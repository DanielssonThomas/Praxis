import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eventIdSchema } from "@praxis/contracts";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { mcpAuthoritySchema } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";
import { z } from "zod";
import { ApprovalError, ApprovalService } from "./index.js";

const inspectInput = z.strictObject({ requestId: eventIdSchema });
const route = "/api/activity";
const routes = new Set([route, `${route}/inspect`, `${route}/decision`]);

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function readOperatorJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ApprovalError("invalid_input", "Send the request as JSON.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 4_096) {
      request.resume();
      throw new ApprovalError("invalid_input", "The request is too large.");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApprovalError("invalid_input", "The request must contain valid JSON.");
  }
}

export function localOperatorGuard(digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Configure a lowercase SHA-256 operator token digest.");
  const expected = Buffer.from(digest, "hex");
  return (request: IncomingMessage): { status: number; error: string } | undefined => {
    const local = new URL(`http://127.0.0.1:${request.socket.localPort}`);
    const sameOrigin = request.headers.origin === local.origin;
    if (request.socket.localAddress !== "127.0.0.1" || request.headers.host !== local.host
      || (!sameOrigin && (request.method === "POST" || request.headers.origin !== undefined))) {
      return { status: 403, error: "Use the local Praxis operator interface." };
    }
    const token = /^Bearer ([A-Za-z0-9._~-]{32,256})$/i.exec(request.headers.authorization ?? "")?.[1];
    if (!token || !timingSafeEqual(createHash("sha256").update(token).digest(), expected)) {
      return { status: 401, error: "An operator credential is required." };
    }
  };
}

export async function approvalRoutesFromEnv() {
  const digest = process.env.PRAXIS_OPERATOR_TOKEN_DIGEST;
  const authorityFile = process.env.PRAXIS_MCP_CONFIG_FILE;
  const origin = process.env.PRAXIS_HERMES_ORIGIN;
  const apiKey = process.env.PRAXIS_HERMES_API_KEY;
  if (digest === undefined || (!origin && !apiKey)) return;
  if (!authorityFile || !origin || !apiKey) {
    throw new Error("Configure the operator token digest, MCP authority file and local Hermes credentials for activity.");
  }

  const operator = localOperatorGuard(digest);
  const load = async () => mcpAuthoritySchema.parse(JSON.parse(await readFile(authorityFile, "utf8")));
  const initial = await load();
  const runtime = new HermesRuntime({ origin, apiKey });
  const store = new OperationalStore(initial.database);
  const loadGrants = async () => {
    const config = await load();
    if (config.database !== initial.database || config.grants.some(({ tokenDigest }) => tokenDigest === digest)) {
      throw new Error("The approval authority configuration is unavailable.");
    }
    return config.grants;
  };
  const service = new ApprovalService({ store, runtime, loadGrants });
  let advance: Promise<void> | undefined;
  const routineTimer = setInterval(() => {
    advance ??= service.advanceRoutine().catch(() => {
      // The activity endpoint reports an unavailable store or authority configuration.
    }).finally(() => { advance = undefined; });
  }, 1_000);
  routineTimer.unref();

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = request.url ?? "";
    if (!routes.has(path)) return false;

    const denied = operator(request);
    if (denied !== undefined) {
      send(response, denied.status, { error: denied.error });
      return true;
    }

    try {
      if (path === route && request.method === "GET") {
        send(response, 200, await service.list());
      } else if (path === `${route}/inspect` && request.method === "POST") {
        const input = inspectInput.safeParse(await readOperatorJson(request));
        if (!input.success) throw new ApprovalError("invalid_input", "Supply an exact action request ID.");
        send(response, 200, await service.inspect(input.data.requestId));
      } else if (path === `${route}/decision` && request.method === "POST") {
        send(response, 200, await service.decide(await readOperatorJson(request)));
      } else {
        response.setHeader("Allow", path === route ? "GET" : "POST");
        send(response, 405, { error: "This activity route does not support that method." });
      }
    } catch (error) {
      if (error instanceof ApprovalError) {
        const status = error.code === "invalid_input" ? 400 : error.code === "not_found" ? 404 : 409;
        send(response, status, { error: error.message, code: error.code });
      } else {
        send(response, 503, { error: "The local activity service is unavailable." });
      }
    }
    return true;
  }

  return {
    async close() {
      clearInterval(routineTimer);
      await advance;
      store.close();
    },
    serve,
  };
}
