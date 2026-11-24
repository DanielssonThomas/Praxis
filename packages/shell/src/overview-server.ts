import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { ApprovalActivity } from "@praxis/approvals";
import { localOperatorGuard } from "@praxis/approvals/http";
import { principalIdSchema } from "@praxis/contracts";
import type { RuntimeSessionSnapshot, Session, Task, Usage } from "@praxis/contracts";
import { HermesRuntime, HermesRuntimeError } from "@praxis/hermes-runtime";
import type { HermesAssignment, HermesOutputCursor } from "@praxis/hermes-runtime";
import { mcpAuthoritySchema } from "@praxis/mcp";
import type { McpGrant } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";

type PaneRuntime = { availability: "available"; snapshot: RuntimeSessionSnapshot; usage: Usage }
  | { availability: "unavailable"; reason: string };
export interface OverviewPane {
  task: Task;
  session: Session;
  ticket: string;
  highlighted: boolean;
  runtime: PaneRuntime;
}
export interface OverviewProjection {
  panes: OverviewPane[];
  association: { available: true } | { available: false; reason: string };
}
const paneLimit = 10;
interface OverviewOptions {
  store: OperationalStore;
  runtime: Pick<HermesRuntime, "inspectLiveAssignment">;
  loadGrants: () => Promise<McpGrant[]>;
  loadActivity?: () => Promise<ApprovalActivity[]>;
  managerPrincipal?: string;
}

function assignmentsFor(grants: McpGrant[]): HermesAssignment[] {
  const registered = new Map<string, HermesAssignment>();
  const conflicting = new Set<string>();
  for (const grant of grants) {
    for (const { sessionId, assignment } of grant.sessions) {
      if (assignment === undefined) continue;
      const prior = registered.get(sessionId);
      if (prior !== undefined && (prior.runId !== assignment.runId || prior.taskId !== assignment.taskId)) {
        conflicting.add(sessionId);
      }
      registered.set(sessionId, assignment);
    }
  }
  return [...registered.values()].filter(({ sessionId }) => !conflicting.has(sessionId));
}

export class OverviewService {
  readonly #cursors = new Map<string, HermesOutputCursor>();
  #pending?: Promise<OverviewProjection>;
  readonly #options: OverviewOptions;

  constructor(options: OverviewOptions) {
    this.#options = options;
  }

  list(): Promise<OverviewProjection> {
    this.#pending ??= this.#project().finally(() => { this.#pending = undefined; });
    return this.#pending;
  }

  async #project(): Promise<OverviewProjection> {
    const { store, runtime, loadGrants, loadActivity, managerPrincipal } = this.#options;
    const grants = await loadGrants();
    const registered = assignmentsFor(grants).flatMap((assignment) => {
      const session = store.getSession(assignment.sessionId);
      const task = store.getTask(assignment.taskId);
      return session !== undefined && task !== undefined && session.taskId === task.id ? [{ assignment, session, task }] : [];
    }).slice(0, paneLimit);
    const activeRuns = new Set(registered.map(({ assignment }) => assignment.runId));
    for (const runId of this.#cursors.keys()) {
      if (!activeRuns.has(runId)) this.#cursors.delete(runId);
    }

    let association: OverviewProjection["association"] = { available: false, reason: "A manager activity principal is not configured." };
    let highlighted: Session["id"] | undefined;
    if (loadActivity !== undefined && grants.some(({ principalId }) => principalId === managerPrincipal)) {
      try {
        const activity = await loadActivity();
        association = { available: true };
        for (const item of activity) {
          if (item.actorId === managerPrincipal && item.action.target.kind === "session"
            && (item.state === "processing" || item.state === "attention")
            && registered.some(({ session }) => session.id === item.action.target.id)) {
            highlighted = item.action.target.id;
          }
        }
      } catch {
        association = { available: false, reason: "Manager activity is unavailable." };
      }
    }

    const panes = await Promise.all(registered.map(async ({ assignment, session, task }): Promise<OverviewPane> => {
      const links = store.eventsFor(task.id).flatMap(({ details }) => details?.type === "issue_link" ? [details.issue] : []);
      const issue = links.at(-1);
      const ticket = issue === undefined ? task.id : `${issue.repository}#${issue.number}`;
      let observed: PaneRuntime;
      try {
        const live = await runtime.inspectLiveAssignment(assignment, this.#cursors.get(assignment.runId));
        if (live.snapshot.taskId !== task.id || live.snapshot.sessionId !== session.id || live.usage.sessionId !== session.id) {
          throw new HermesRuntimeError("assignment_mismatch", "The native Overview receipt identified another session.");
        }
        if (live.cursor === undefined) this.#cursors.delete(assignment.runId);
        else this.#cursors.set(assignment.runId, live.cursor);
        observed = { availability: "available", snapshot: live.snapshot, usage: live.usage };
      } catch (error) {
        const reason = error instanceof HermesRuntimeError ? error.message : "The native session is unavailable.";
        observed = { availability: "unavailable", reason };
      }
      return { task, session, ticket, runtime: observed, highlighted: session.id === highlighted };
    }));
    return { panes, association };
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function overviewRoutesFromEnv(loadActivity?: () => Promise<ApprovalActivity[]>) {
  const file = process.env.PRAXIS_MCP_CONFIG_FILE;
  const origin = process.env.PRAXIS_HERMES_ORIGIN;
  const key = process.env.PRAXIS_HERMES_API_KEY;
  const digest = process.env.PRAXIS_OPERATOR_TOKEN_DIGEST;
  if (!file || !origin || !key || !digest) return;
  const suppliedPrincipal = process.env.PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID;
  const managerPrincipal = suppliedPrincipal === undefined ? undefined : principalIdSchema.parse(suppliedPrincipal);
  const readAuthority = async () => mcpAuthoritySchema.parse(JSON.parse(await readFile(file, "utf8")));
  const database = resolve((await readAuthority()).database);
  const loadGrants = async () => {
    const config = await readAuthority();
    if (resolve(config.database) !== database || config.grants.some(({ tokenDigest }) => tokenDigest === digest)) {
      throw new Error("The Overview authority is unavailable.");
    }
    return config.grants;
  };
  const guard = localOperatorGuard(digest);
  const store = new OperationalStore(database);
  const runtime = new HermesRuntime({ origin, apiKey: key });
  const view = new OverviewService({ store, runtime, loadGrants, loadActivity, managerPrincipal });

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.url !== "/api/overview") return false;
    const denied = guard(request);
    if (denied !== undefined) send(response, denied.status, { error: denied.error });
    else if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      send(response, 405, { error: "Overview supports read requests." });
    } else {
      try {
        send(response, 200, await view.list());
      } catch {
        send(response, 503, { error: "The local Overview source is unavailable." });
      }
    }
    return true;
  }

  return { serve, close: () => store.close() };
}
