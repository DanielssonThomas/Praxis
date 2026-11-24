import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { ApprovalError } from "@praxis/approvals";
import { localOperatorGuard, readOperatorJson } from "@praxis/approvals/http";
import { mcpAuthoritySchema } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";
import { GitHubIssueProvider, HermesKanban, KanbanBoard, KanbanError } from "./index.js";

const endpoint = "/api/kanban";
const linkEndpoint = `${endpoint}/link`;

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function kanbanRoutesFromEnv() {
  const home = process.env.PRAXIS_KANBAN_HERMES_HOME;
  if (home === undefined) return;
  const digest = process.env.PRAXIS_OPERATOR_TOKEN_DIGEST;
  if (!digest) throw new Error("Configure the operator token digest for Kanban.");

  const authorityFile = process.env.PRAXIS_MCP_CONFIG_FILE;
  const loadAuthority = async () => authorityFile === undefined ? undefined
    : mcpAuthoritySchema.parse(JSON.parse(await readFile(authorityFile, "utf8")));
  const authority = await loadAuthority();
  const configured = process.env.PRAXIS_KANBAN_DATABASE ?? authority?.database;
  if (!configured) throw new Error("Configure the local operational database for Kanban.");

  const database = resolve(configured);
  const guard = localOperatorGuard(digest);
  const reader = new HermesKanban({
    executable: process.env.PRAXIS_KANBAN_HERMES_BIN ?? "hermes",
    home,
    board: process.env.PRAXIS_KANBAN_BOARD,
  });
  const token = process.env.PRAXIS_GITHUB_TOKEN;
  const provider = token === undefined
    ? undefined : new GitHubIssueProvider({ token, origin: process.env.PRAXIS_GITHUB_API_ORIGIN });
  const store = new OperationalStore(database);
  const board = new KanbanBoard({ reader, store, provider });

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = request.url ?? "";
    if (path !== endpoint && path !== linkEndpoint) return false;
    const denied = guard(request);
    if (denied !== undefined) {
      send(response, denied.status, { error: denied.error });
      return true;
    }

    try {
      const currentAuthority = await loadAuthority();
      if (currentAuthority !== undefined && (resolve(currentAuthority.database) !== database
        || currentAuthority.grants.some(({ tokenDigest }) => tokenDigest === digest))) {
        send(response, 403, { error: "The configured local operator scope is unavailable for this board." });
      } else if (path === endpoint && request.method === "GET") {
        send(response, 200, await board.list());
      } else if (path === linkEndpoint && request.method === "POST") {
        send(response, 200, await board.linkIssue(await readOperatorJson(request)));
      } else {
        response.setHeader("Allow", path === endpoint ? "GET" : "POST");
        send(response, 405, { error: "This Kanban route does not support that method." });
      }
    } catch (error) {
      if (error instanceof ApprovalError) {
        send(response, 400, { error: error.message });
      } else if (error instanceof KanbanError) {
        const status = {
          invalid_input: 400, not_found: 404, unauthorized: 403, unsupported: 503, unavailable: 503,
        }[error.code];
        send(response, status, { error: error.message, code: error.code });
      } else {
        send(response, 503, { error: "The local Kanban view is unavailable." });
      }
    }
    return true;
  }

  return { close: () => store.close(), serve };
}
