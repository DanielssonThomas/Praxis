import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { settingsPath } from "@praxis/settings";
import { serveSettings } from "@praxis/settings/http";

const port = Number(process.env.PRAXIS_PORT ?? 3210);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("Set PRAXIS_PORT to an integer from 0 to 65535.");
}

const config = settingsPath();
const assets = new Map([
  ["/", { url: new URL("../web/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/assets/shell.css", { url: new URL("../web/shell.css", import.meta.url), type: "text/css; charset=utf-8" }],
  ["/assets/shell.js", { url: new URL("./browser.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
]);

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (await serveSettings(request, response, config)) return;
  const asset = assets.get(request.url?.split("?")[0] ?? "");
  if (asset === undefined) {
    response.writeHead(404).end("Page not found.");
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" }).end("Method not allowed.");
    return;
  }
  const body = await readFile(asset.url);
  response.writeHead(200, {
    "Content-Type": asset.type,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
  }).end(body);
}

const server = createServer((request, response) => {
  void serve(request, response).catch(() => {
    if (response.headersSent) response.destroy();
    else response.writeHead(500).end("Praxis is unavailable.");
  });
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address !== null && typeof address !== "string") {
    console.log(`Praxis at http://127.0.0.1:${address.port}/`);
  }
});
