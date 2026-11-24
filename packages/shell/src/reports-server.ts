import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { ApprovalError } from "@praxis/approvals";
import { localOperatorGuard, readOperatorJson } from "@praxis/approvals/http";
import { mcpAuthoritySchema } from "@praxis/mcp";
import { defaultReportPreferences, readSettings, reportDaysSchema, reportPreferencesSchema, updateSettings } from "@praxis/settings";
import type { ReportDays } from "@praxis/settings";
import { OperationalStore } from "@praxis/state";
import { projectReports } from "./report-projection.js";
import type { ReportResult } from "./report-projection.js";

const route = "/api/reports";
const preferencesRoute = `${route}/preferences`;
const clearRoute = `${route}/clear`;
const routes = new Set([route, preferencesRoute, clearRoute]);

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

class ReportsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function reportsRoutesFromEnv(settingsFile: string) {
  const digest = process.env.PRAXIS_OPERATOR_TOKEN_DIGEST;
  const authorityFile = process.env.PRAXIS_MCP_CONFIG_FILE;
  const configured = process.env.PRAXIS_REPORTS_DATABASE;
  if (!digest || (!authorityFile && !configured)) return;

  const operator = localOperatorGuard(digest);
  const loadAuthority = async () => authorityFile === undefined
    ? undefined : mcpAuthoritySchema.parse(JSON.parse(await readFile(authorityFile, "utf8")));
  const initial = await loadAuthority();
  const database = resolve(initial?.database ?? configured!);
  if (configured && resolve(configured) !== database) {
    throw new Error("Use the same operational database for Praxis reports and MCP.");
  }

  const store = new OperationalStore(database);

  async function report(days: ReportDays): Promise<ReportResult> {
    const preferences = (await readSettings(settingsFile)).reports ?? defaultReportPreferences();
    return { preferences, ...projectReports(store, preferences, days, new Date()) };
  }

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!routes.has(url.pathname)) return false;
    const denied = operator(request);
    if (denied) {
      send(response, denied.status, { error: denied.error });
      return true;
    }

    try {
      const authority = await loadAuthority();
      if (authority && (resolve(authority.database) !== database
        || authority.grants.some(({ tokenDigest }) => tokenDigest === digest))) {
        throw new ReportsError(503, "The local reports authority is unavailable.");
      }
      const allowed = url.pathname === route ? "GET" : "POST";
      if (request.method !== allowed) {
        response.setHeader("Allow", allowed);
        throw new ReportsError(405, "This reports route does not support that method.");
      }
      const days = reportDaysSchema.safeParse(Number(url.searchParams.get("days") ?? 30));
      if (!days.success) throw new ReportsError(400, "Choose a 7, 30 or 90 day range.");

      if (url.pathname === preferencesRoute) {
        const parsed = reportPreferencesSchema.safeParse(await readOperatorJson(request));
        if (!parsed.success) throw new ReportsError(400, "Choose valid report preferences.");
        await updateSettings(settingsFile, (current) => ({
          ...current, reports: { ...parsed.data, clearedBefore: current.reports?.clearedBefore },
        }));
      } else if (url.pathname === clearRoute) {
        const input = await readOperatorJson(request);
        if (typeof input !== "object" || input === null || !("confirmed" in input) || input.confirmed !== true) {
          throw new ReportsError(400, "Confirm the report history clear.");
        }
        await updateSettings(settingsFile, (current) => {
          const reports = current.reports ?? defaultReportPreferences();
          if (!reports.allowClearHistory) throw new ReportsError(409, "Enable clearing history in report preferences.");
          const cutoff = new Date().toISOString();
          const clearedBefore = reports.clearedBefore && reports.clearedBefore > cutoff
            ? reports.clearedBefore : cutoff;
          return { ...current, reports: { ...reports, clearedBefore } };
        });
      }

      send(response, 200, await report(days.data));
    } catch (error) {
      if (error instanceof ReportsError || error instanceof ApprovalError) {
        send(response, error instanceof ReportsError ? error.status : 400, { error: error.message });
      } else {
        send(response, 503, { error: "Local reports are unavailable. Check the operational store and settings." });
      }
    }
    return true;
  }

  return { close: () => store.close(), serve };
}
