import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  actionSchema,
  contractVersion,
  eventIdSchema,
  eventSchema,
  principalIdSchema,
  runtimeSessionSnapshotSchema,
  sessionIdSchema,
  taskIdSchema,
  workerReportMessageSchema,
  workerReportPhaseSchema,
} from "@praxis/contracts";
import type { Action, SessionId, TaskId } from "@praxis/contracts";
import { hermesAssignmentSchema } from "@praxis/hermes-runtime";
import type { HermesRuntime } from "@praxis/hermes-runtime";
import { OperationalStoreError } from "@praxis/state";
import type { OperationalStore } from "@praxis/state";
import { z } from "zod";
import { MemoryError, memoryId, recordMemorySchema, retrieveMemorySchema } from "./memory.js";
import type { ProjectMemory } from "./memory.js";

const sessionGrant = z.strictObject({
  sessionId: sessionIdSchema,
  canReport: z.boolean(),
  assignment: hermesAssignmentSchema.optional(),
  operatorCanTakeover: z.boolean().optional(),
}).refine(
  ({ sessionId, assignment }) => assignment === undefined || assignment.sessionId === sessionId,
  "A native assignment must match the granted session",
);

const grantSchema = z.strictObject({
  principalId: principalIdSchema,
  tokenDigest: z.string().regex(/^[0-9a-f]{64}$/),
  taskIds: z.array(taskIdSchema),
  sessions: z.array(sessionGrant).refine(
    (sessions) => new Set(sessions.map(({ sessionId }) => sessionId)).size === sessions.length,
    "Granted session IDs must be unique",
  ),
  actionKinds: z.array(actionSchema.shape.kind),
  memoryProjects: z.array(z.strictObject({ projectId: memoryId, canWrite: z.boolean() })).refine(
    (projects) => new Set(projects.map(({ projectId }) => projectId)).size === projects.length,
    "Granted memory projects must be unique",
  ).optional(),
});
export type McpGrant = z.infer<typeof grantSchema>;
type Grant = McpGrant;

export const mcpGrantsSchema = z.array(grantSchema).min(1).refine(
  (grants) => new Set(grants.map(({ principalId }) => principalId)).size === grants.length
    && new Set(grants.map(({ tokenDigest }) => tokenDigest)).size === grants.length,
  "Each MCP principal and token digest must be unique",
);

export const mcpAuthoritySchema = z.strictObject({
  schemaVersion: z.literal(contractVersion),
  database: z.string().min(1),
  grants: mcpGrantsSchema,
  memory: z.strictObject({ directory: z.string().min(1) }).optional(),
});

interface Options {
  store: OperationalStore;
  grants: unknown;
  runtime?: Pick<HermesRuntime, "inspectAssignment">;
  memory?: { service: ProjectMemory; enabled: () => Promise<boolean> };
}
type ToolErrorCode = "forbidden" | "not_found";

class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
  }
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function submissionDigest(grant: Grant, submissionId: string): string {
  return tokenDigest(`${grant.principalId}\0${submissionId}`);
}

function permitTask(grant: Grant, taskId: TaskId): void {
  if (!grant.taskIds.includes(taskId)) throw new ToolError("forbidden", "The task is outside the principal's scope.");
}

function permitSession(grant: Grant, sessionId: SessionId) {
  const access = grant.sessions.find((session) => session.sessionId === sessionId);
  if (access === undefined) throw new ToolError("forbidden", "The session is outside the principal's scope.");
  return access;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new ToolError("not_found", "The scoped record is unavailable.");
  return value;
}

function result(data: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError };
}

async function answer(operation: () => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return result(await operation());
  } catch (error) {
    if (error instanceof ToolError) return result({ code: error.code, message: error.message }, true);
    if (error instanceof MemoryError) return result({ code: error.code, message: error.message }, true);
    if (error instanceof OperationalStoreError && error.code === "identity_conflict") {
      return result({ code: "identity_conflict", message: "This submission ID already records different content." }, true);
    }
    return result({ code: "unavailable", message: "The requested Praxis operation is unavailable." }, true);
  }
}

const submission = {
  submissionId: eventIdSchema,
  occurredAt: eventSchema.shape.occurredAt,
};

export function inspectScopedTask(store: OperationalStore, grant: McpGrant, taskId: TaskId) {
  permitTask(grant, taskId);
  return required(store.getTask(taskId));
}

export async function inspectScopedWorker({ store, runtime }: Pick<Options, "store" | "runtime">, grant: McpGrant, sessionId: SessionId) {
  const { assignment } = permitSession(grant, sessionId);
  const session = required(store.getSession(sessionId));
  if (assignment === undefined) return { session, runtime: { availability: "unavailable" as const, reason: "No native assignment is bound to this session." } };
  if (runtime === undefined) return { session, runtime: { availability: "unavailable" as const, reason: "No native runtime is configured." } };
  if (assignment.taskId !== session.taskId) throw new ToolError("forbidden", "The native assignment is outside the session's scope.");
  const snapshot = runtimeSessionSnapshotSchema.parse(await runtime.inspectAssignment(assignment));
  if (snapshot.sessionId !== session.id || snapshot.taskId !== session.taskId) {
    throw new ToolError("forbidden", "The native snapshot is outside the session's scope.");
  }
  return { session, runtime: { availability: "available" as const, snapshot } };
}

function makeMcp({ store, runtime, memory }: Options, grant: Grant): McpServer {
  const mcp = new McpServer({ name: "praxis", version: "1.0.0" });
  mcp.registerTool("inspect_task", {
    description: "Read a task in the authenticated principal's scope.",
    inputSchema: z.strictObject({ taskId: taskIdSchema }),
    annotations: { readOnlyHint: true },
  }, ({ taskId }) => answer(() => ({ task: inspectScopedTask(store, grant, taskId) })));

  mcp.registerTool("inspect_worker", {
    description: "Read a scoped worker session and its native runtime snapshot when available.",
    inputSchema: z.strictObject({ sessionId: sessionIdSchema }),
    annotations: { readOnlyHint: true },
  }, ({ sessionId }) => answer(() => inspectScopedWorker({ store, runtime }, grant, sessionId)));

  mcp.registerTool("report_worker", {
    description: "Record progress, a question, a result or a blocker for a worker session authorized to report.",
    inputSchema: z.strictObject({
      ...submission,
      sessionId: sessionIdSchema,
      phase: workerReportPhaseSchema,
      message: workerReportMessageSchema,
    }),
    annotations: { destructiveHint: false, idempotentHint: true },
  }, ({ sessionId, phase, message, occurredAt, submissionId }) => answer(() => {
    if (!permitSession(grant, sessionId).canReport) throw new ToolError("forbidden", "This principal cannot report for the session.");
    required(store.getSession(sessionId));
    const event = eventSchema.parse({
      schemaVersion: contractVersion,
      id: `event_${submissionDigest(grant, submissionId)}`,
      occurredAt,
      kind: `worker.${phase}`,
      subject: { kind: "session", id: sessionId },
      details: { type: "worker_report", actorId: grant.principalId, message },
    });
    return { event, write: store.appendEvent(event) };
  }));

  mcp.registerTool("request_action", {
    description: "Record a pending request for a scoped action. This tool does not execute actions.",
    inputSchema: z.strictObject({
      ...submission,
      kind: actionSchema.shape.kind,
      target: actionSchema.shape.target,
    }),
    annotations: { destructiveHint: false, idempotentHint: true },
  }, ({ target, kind, occurredAt, submissionId }) => answer(() => {
    if (!grant.actionKinds.includes(kind)) throw new ToolError("forbidden", "This principal cannot request that action kind.");
    if (target.kind === "task") {
      permitTask(grant, target.id);
      required(store.getTask(target.id));
    } else {
      permitSession(grant, target.id);
      required(store.getSession(target.id));
    }

    const digest = submissionDigest(grant, submissionId);
    const action: Action = actionSchema.parse({ schemaVersion: contractVersion, id: `action_${digest}`, kind, target });
    const event = eventSchema.parse({
      schemaVersion: contractVersion,
      id: `event_${digest}`,
      occurredAt,
      kind: "action.requested",
      subject: target,
      details: { type: "action_request", actorId: grant.principalId, action },
    });
    return { status: "pending", event, write: store.appendEvent(event) };
  }));

  if (memory && grant.memoryProjects?.length) {
    const permitMemory = async (projectId: string, write: boolean) => {
      const project = grant.memoryProjects?.find((item) => item.projectId === projectId);
      if (!project || (write && !project.canWrite)) {
        throw new ToolError("forbidden", "The memory operation is outside the principal's project scope.");
      }
      if (!await memory.enabled()) throw new MemoryError("disabled", "Engineering memory is disabled in Praxis settings.");
    };
    mcp.registerTool("retrieve_memory", {
      description: "Retrieve decisions and verified findings from an authorized project by note ID or text search.",
      inputSchema: retrieveMemorySchema,
      annotations: { readOnlyHint: true },
    }, (input) => answer(async () => {
      await permitMemory(input.projectId, false);
      return memory.service.retrieve(input);
    }));
    mcp.registerTool("record_memory", {
      description: "Save a project decision or verified finding. Supply verification evidence for a finding and reuse the note ID when retrying.",
      inputSchema: recordMemorySchema,
      annotations: { destructiveHint: false, idempotentHint: true },
    }, (input) => answer(async () => {
      await permitMemory(input.projectId, true);
      return memory.service.record(input);
    }));
  }

  return mcp;
}

function reject(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function validLocalRequest(request: IncomingMessage): boolean {
  const localOrigin = new URL(`http://127.0.0.1:${request.socket.localPort}`);
  return request.socket.localAddress === "127.0.0.1" && request.headers.host === localOrigin.host
    && (request.headers.origin === undefined || request.headers.origin === localOrigin.origin);
}

export function createPraxisMcpServer(options: Options) {
  const grants = new Map(mcpGrantsSchema.parse(options.grants).map((grant) => [grant.tokenDigest, grant]));

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== "/mcp") {
      reject(response, 404, "MCP is available at /mcp.");
      return;
    }
    if (!validLocalRequest(request)) {
      reject(response, 403, "Use the local Praxis MCP address.");
      return;
    }

    const token = /^Bearer ([A-Za-z0-9._~-]{32,256})$/i.exec(request.headers.authorization ?? "")?.[1];
    const grant = token === undefined ? undefined : grants.get(tokenDigest(token));
    if (grant === undefined) {
      response.setHeader("WWW-Authenticate", "Bearer");
      reject(response, 401, "A valid Praxis MCP credential is required.");
      return;
    }

    const mcp = makeMcp(options, grant);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.setHeader("Cache-Control", "no-store");
    response.once("close", () => { void mcp.close().catch(() => {}); });
    await mcp.connect(transport);
    await transport.handleRequest(request, response);
  }

  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else reject(response, 500, "Praxis MCP is unavailable.");
    });
  });
}
