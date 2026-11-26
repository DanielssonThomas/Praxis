import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { ApprovalError } from "@praxis/approvals";
import type { ApprovalActivity } from "@praxis/approvals";
import { localOperatorGuard, readOperatorJson } from "@praxis/approvals/http";
import { principalIdSchema, runtimeSessionSnapshotSchema, usageSchema, workerAssignmentSchema } from "@praxis/contracts";
import type { RuntimeSessionSnapshot, Session, Task, Usage, WorkerAssignment, WorkerObservation } from "@praxis/contracts";
import { HermesRuntime, HermesRuntimeError } from "@praxis/hermes-runtime";
import type { HermesAssignment, HermesOutputCursor } from "@praxis/hermes-runtime";
import { mcpAuthoritySchema } from "@praxis/mcp";
import type { McpGrant } from "@praxis/mcp";
import { OperationalStore, OperationalStoreError } from "@praxis/state";
import { resolveManagerResource, unavailableManagerResources } from "./manager-resources.js";
import type { ReadManagerResources } from "./manager-resources.js";
import { SessionControlError, SessionControlService } from "./session-control.js";
import type { ControlBinding, SessionControlView } from "./session-control.js";

type PaneRuntime = { availability: "available"; snapshot: RuntimeSessionSnapshot; usage: Usage }
  | { availability: "unavailable"; reason: string };
export interface OverviewPane {
  task: Task;
  session: Session;
  ticket: string;
  highlighted: boolean;
  runtime: PaneRuntime;
  control: SessionControlView & { unavailableReason?: string };
  worker?: { runtime: "codex"; runId: string };
  usageNotice?: string;
}
export interface OverviewProjection {
  panes: OverviewPane[];
  association: { available: true } | { available: false; reason: string };
  page: { number: number; count: number };
}
const overviewPath = "/api/overview";
const paneLimit = 10;
const maximumPage = 0xffff_ffff;
const invalidPage = "Supply a positive whole Overview page number.";
const settledStatuses = new Set<RuntimeSessionSnapshot["status"]>(["completed", "failed", "stopped", "interrupted"]);
type LoadCodex = () => Promise<readonly { assignment: WorkerAssignment; observation: WorkerObservation }[]>;
interface OverviewOptions {
  store: OperationalStore;
  runtime: Pick<HermesRuntime, "inspectLiveAssignment">;
  loadGrants: () => Promise<McpGrant[]>;
  loadActivity?: () => Promise<ApprovalActivity[]>;
  loadCodex?: LoadCodex;
  managerPrincipal?: string;
  controls: SessionControlService;
}

function assignmentsFor(grants: McpGrant[]): ControlBinding[] {
  const registered = new Map<string, ControlBinding>();
  const conflicting = new Set<string>();
  for (const grant of grants) {
    for (const { sessionId, assignment, operatorCanTakeover } of grant.sessions) {
      if (assignment === undefined) continue;
      const prior = registered.get(sessionId);
      if (prior !== undefined && (prior.assignment.runId !== assignment.runId || prior.assignment.taskId !== assignment.taskId)) {
        conflicting.add(sessionId);
      }
      registered.set(sessionId, { assignment, enabled: prior?.enabled === true || operatorCanTakeover === true });
    }
  }
  return [...registered.values()].filter(({ assignment }) => !conflicting.has(assignment.sessionId));
}

interface AssignmentObservation {
  cursor?: HermesOutputCursor;
  pending?: Promise<PaneRuntime>;
}

function isPageNumber(page: number): boolean {
  return Number.isInteger(page) && page >= 1 && page <= maximumPage;
}

function readPage(query: string): number | undefined {
  const params = new URLSearchParams(query);
  if (params.size === 0) return 1;
  const value = params.get("page");
  if (params.size !== 1 || value === null || !/^[1-9][0-9]{0,9}$/.test(value)) return undefined;
  const page = Number(value);
  return isPageNumber(page) ? page : undefined;
}

export class OverviewService {
  readonly #observations = new Map<string, AssignmentObservation>();
  readonly #pending = new Map<number, Promise<OverviewProjection>>();
  readonly #options: OverviewOptions;

  constructor(options: OverviewOptions) {
    this.#options = options;
  }

  list(requestedPage = 1): Promise<OverviewProjection> {
    if (!isPageNumber(requestedPage)) return Promise.reject(new RangeError(invalidPage));
    const pending = this.#pending.get(requestedPage);
    if (pending !== undefined) return pending;
    const read = this.#project(requestedPage).finally(() => { this.#pending.delete(requestedPage); });
    this.#pending.set(requestedPage, read);
    return read;
  }

  async #project(requestedPage: number): Promise<OverviewProjection> {
    const { store, loadGrants, loadActivity, loadCodex, managerPrincipal, controls } = this.#options;
    const grants = await loadGrants();
    const hermes = assignmentsFor(grants).flatMap((binding) => {
      const { assignment } = binding;
      const session = store.getSession(assignment.sessionId);
      const task = store.getTask(assignment.taskId);
      return session !== undefined && task !== undefined && session.taskId === task.id
        ? [{ kind: "hermes" as const, binding, assignment, session, task, key: JSON.stringify([task.id, session.id, assignment.runId]) }] : [];
    });
    const seen = new Set(hermes.map(({ session }) => session.id));
    const registrations = loadCodex === undefined ? [] : await loadCodex().catch(() => []);
    const codex = registrations.flatMap((entry) => {
      const assignment = workerAssignmentSchema.safeParse(entry.assignment);
      const snapshot = runtimeSessionSnapshotSchema.safeParse(entry.observation.snapshot);
      const usage = usageSchema.safeParse(entry.observation.usage);
      if (!assignment.success || assignment.data.runtime !== "codex" || !snapshot.success || !usage.success) return [];
      const { taskId, sessionId, runId } = assignment.data;
      const session = store.getSession(sessionId);
      const task = store.getTask(taskId);
      if (session?.taskId !== taskId || task === undefined || seen.has(sessionId) || snapshot.data.taskId !== taskId
        || snapshot.data.sessionId !== sessionId || usage.data.sessionId !== sessionId || usage.data.id !== `usage_${runId}`) return [];
      seen.add(sessionId);
      return [{ kind: "codex" as const, task, session, runId, snapshot: snapshot.data, usage: usage.data }];
    });
    const eligible = [...hermes, ...codex];
    const count = Math.max(1, Math.ceil(eligible.length / paneLimit));
    const number = Math.min(requestedPage, count);
    const offset = (number - 1) * paneLimit;
    const page = { number, count };

    const active = new Set(hermes.map(({ key }) => key));
    for (const key of this.#observations.keys()) {
      if (!active.has(key)) this.#observations.delete(key);
    }
    const registered = eligible.slice(offset, offset + paneLimit);

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

    const panes = await Promise.all(registered.map(async (pane): Promise<OverviewPane> => {
      const { session, task } = pane;
      const links = store.eventsFor(task.id).flatMap(({ details }) => details?.type === "issue_link" ? [details.issue] : []);
      const issue = links.at(-1);
      const ticket = issue === undefined ? task.id : `${issue.repository}#${issue.number}`;
      let observed: PaneRuntime;
      let control: OverviewPane["control"];
      let worker: OverviewPane["worker"];
      if (pane.kind === "codex") {
        observed = { availability: "available", snapshot: pane.snapshot, usage: pane.usage };
        control = {
          mode: "read_only", canTakeover: false, canGuide: false, canReturn: false, guidance: "none",
          unavailableReason: "Takeover, guidance, and handback are unavailable for this Codex worker.",
        };
        worker = { runtime: "codex", runId: pane.runId };
      } else {
        const observation = this.#observations.get(pane.key) ?? {};
        this.#observations.set(pane.key, observation);
        observed = await this.#observe(pane.assignment, observation);
        control = controls.view(pane.binding, observed.availability === "available" && observed.snapshot.status === "running");
      }
      let usageNotice: string | undefined;
      if (observed.availability === "available" && observed.usage.metering === "reported"
        && settledStatuses.has(observed.snapshot.status)) {
        try {
          store.recordUsageObservation(observed.usage, new Date().toISOString());
        } catch (error) {
          usageNotice = error instanceof OperationalStoreError && error.code === "identity_conflict"
            ? "A local record conflicts with this Reports measurement."
            : "Could not save runtime usage to Reports.";
        }
      }
      return {
        task, session, ticket, runtime: observed, usageNotice, highlighted: session.id === highlighted,
        control, worker,
      };
    }));
    return { panes, association, page };
  }

  #observe(assignment: HermesAssignment, observation: AssignmentObservation): Promise<PaneRuntime> {
    observation.pending ??= this.#inspect(assignment, observation).finally(() => { observation.pending = undefined; });
    return observation.pending;
  }

  async #inspect(assignment: HermesAssignment, observation: AssignmentObservation): Promise<PaneRuntime> {
    try {
      const live = await this.#options.runtime.inspectLiveAssignment(assignment, observation.cursor);
      if (live.snapshot.taskId !== assignment.taskId || live.snapshot.sessionId !== assignment.sessionId
        || live.usage.sessionId !== assignment.sessionId) {
        throw new HermesRuntimeError("assignment_mismatch", "The native Overview receipt identified another session.");
      }
      observation.cursor = live.cursor;
      return { availability: "available", snapshot: live.snapshot, usage: live.usage };
    } catch (error) {
      const reason = error instanceof HermesRuntimeError ? error.message : "The native session is unavailable.";
      return { availability: "unavailable", reason };
    }
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function overviewRoutesFromEnv(loadActivity?: () => Promise<ApprovalActivity[]>, loadCodex?: LoadCodex) {
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
  const controls = new SessionControlService({
    store, runtime,
    loadBinding: async (id) => {
      const binding = assignmentsFor(await loadGrants()).find(({ assignment }) => assignment.sessionId === id);
      if (binding !== undefined && store.getSession(id)?.taskId === binding.assignment.taskId) return binding;
    },
  });
  const view = new OverviewService({ store, runtime, loadGrants, loadActivity, loadCodex, managerPrincipal, controls });

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const target = request.url ?? "";
    const queryStart = target.indexOf("?");
    const path = queryStart === -1 ? target : target.slice(0, queryStart);
    const controlRoute = target === "/api/overview/control";
    if (!controlRoute && path !== overviewPath) return false;
    const method = controlRoute ? "POST" : "GET";
    const denied = guard(request);
    if (denied !== undefined) send(response, denied.status, { error: denied.error });
    else if (request.method !== method) {
      response.setHeader("Allow", method);
      send(response, 405, { error: "This Overview route does not support that method." });
    } else {
      try {
        if (controlRoute) {
          send(response, 200, await controls.operate(await readOperatorJson(request)));
        } else {
          const page = readPage(queryStart === -1 ? "" : target.slice(queryStart + 1));
          if (page === undefined) send(response, 400, { code: "invalid_input", error: invalidPage });
          else send(response, 200, await view.list(page));
        }
      } catch (error) {
        if (error instanceof SessionControlError || error instanceof ApprovalError) {
          send(response, error instanceof SessionControlError ? error.status : 400, { error: error.message });
        } else if (controlRoute && error instanceof HermesRuntimeError) {
          send(response, 503, { error: error.message });
        } else {
          send(response, 503, { error: "The local Overview source is unavailable." });
        }
      }
    }
    return true;
  }

  const readManagerResources: ReadManagerResources = async (references) => {
    const grant = (await loadGrants()).find(({ principalId }) => principalId === managerPrincipal);
    if (!grant) return unavailableManagerResources(references);
    return Promise.all(references.map((reference) => resolveManagerResource(store, runtime, grant, reference)));
  };
  return { serve, readManagerResources, close: () => store.close() };
}
