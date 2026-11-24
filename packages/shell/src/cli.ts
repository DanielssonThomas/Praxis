import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { approvalRoutesFromEnv } from "@praxis/approvals/http";
import { kanbanRoutesFromEnv } from "@praxis/kanban/http";
import { settingsPath } from "@praxis/settings";
import { serveSettings } from "@praxis/settings/http";
import { overviewRoutesFromEnv } from "./overview-server.js";
import { reportsRoutesFromEnv } from "./reports-server.js";

const port = Number(process.env.PRAXIS_PORT ?? 3210);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("Set PRAXIS_PORT to an integer from 0 to 65535.");
}

const config = settingsPath();
const activity = await approvalRoutesFromEnv();
const kanban = await kanbanRoutesFromEnv();
const overview = await overviewRoutesFromEnv(activity?.list);
const reports = await reportsRoutesFromEnv(config);
const assets = new Map([
  ["/", { url: new URL("../web/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/assets/shell.css", { url: new URL("../web/shell.css", import.meta.url), type: "text/css; charset=utf-8" }],
  ["/assets/shell.js", { url: new URL("./browser.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ["/assets/activity.js", { url: new URL("./activity.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ["/assets/kanban.js", { url: new URL("./kanban.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ["/assets/overview.js", { url: new URL("./overview.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ["/assets/reports.js", { url: new URL("./reports.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ["/assets/chart.js", {
    url: new URL("./chart.umd.min.js", import.meta.resolve("chart.js")),
    type: "text/javascript; charset=utf-8",
  }],
]);

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (await serveSettings(request, response, config)) return;
  if (await activity?.serve(request, response)) return;
  if (await kanban?.serve(request, response)) return;
  if (await overview?.serve(request, response)) return;
  if (await reports?.serve(request, response)) return;
  const path = request.url?.split("?")[0] ?? "";
  const asset = assets.get(path);
  if (asset === undefined) {
    response.writeHead(404).end("Page not found.");
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" }).end("Method not allowed.");
    return;
  }
  const body = await readFile(asset.url);
  const payload = path === "/"
    ? body.toString("utf8")
      .replace('data-activity="unavailable"', `data-activity="${activity === undefined ? "unavailable" : "available"}"`)
      .replace('data-kanban="unavailable"', `data-kanban="${kanban === undefined ? "unavailable" : "available"}"`)
      .replace('data-overview="unavailable"', `data-overview="${overview === undefined ? "unavailable" : "available"}"`)
      .replace('data-reports="unavailable"', `data-reports="${reports === undefined ? "unavailable" : "available"}"`)
    : body;
  response.writeHead(200, {
    "Content-Type": asset.type,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
  }).end(payload);
}

const server = createServer((request, response) => {
  void serve(request, response).catch(() => {
    if (response.headersSent) response.destroy();
    else response.writeHead(500).end("Praxis is unavailable.");
  });
});
server.once("close", () => {
  void activity?.close();
  kanban?.close();
  overview?.close();
  reports?.close();
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address !== null && typeof address !== "string") {
    console.log(`Praxis at http://127.0.0.1:${address.port}/`);
  }
});
