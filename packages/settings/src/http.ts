import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { readSettings, saveSettings, SettingsError } from "./index.js";

const assets = new Map([
  ["/settings", { url: new URL("../web/settings.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/assets/settings.css", { url: new URL("../web/settings.css", import.meta.url), type: "text/css; charset=utf-8" }],
  ["/assets/settings.js", { url: new URL("./browser.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
]);
const settingsApi = "/api/settings";
const jsonType = "application/json; charset=utf-8";
const maxBodyBytes = 16_384;

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer): void {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendError(response: ServerResponse, status: number, message: string): void {
  send(response, status, jsonType, JSON.stringify({ error: message }));
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) {
      request.resume();
      throw new RequestError(413, "The settings file is too large.");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "Send settings as valid JSON.");
  }
}

export async function serveSettings(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
  const url = request.url?.split("?")[0] ?? "";
  const asset = assets.get(url);
  if (asset === undefined && url !== settingsApi) return false;

  const origin = new URL(`http://127.0.0.1:${request.socket.localPort}`);
  if (request.socket.localAddress !== "127.0.0.1" || request.headers.host !== origin.host) {
    sendError(response, 403, "Open settings from the local Praxis address.");
    return true;
  }

  try {
    if (request.method === "GET") {
      if (asset === undefined) {
        send(response, 200, jsonType, JSON.stringify(await readSettings(path)));
      } else {
        send(response, 200, asset.type, await readFile(asset.url));
      }
    } else if (request.method === "PUT" && url === settingsApi) {
      if (request.headers.origin !== origin.origin) throw new RequestError(403, "Save settings from the local Praxis editor.");
      if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
        throw new RequestError(415, "Send settings with the application/json content type.");
      }
      send(response, 200, jsonType, JSON.stringify(await saveSettings(path, await requestJson(request))));
    } else {
      response.setHeader("Allow", asset === undefined ? "GET, PUT" : "GET");
      throw new RequestError(405, "This settings route does not support that method.");
    }
  } catch (error) {
    if (error instanceof RequestError) {
      sendError(response, error.status, error.message);
    } else if (error instanceof SettingsError) {
      const status = error.code === "invalid_settings" && request.method === "PUT" ? 400 : 500;
      sendError(response, status, error.message);
    } else {
      sendError(response, 500, "Praxis settings are unavailable.");
    }
  }
  return true;
}

export function createSettingsServer(path: string) {
  return createServer((request, response) => {
    void serveSettings(request, response, path)
      .then((handled) => {
        if (!handled) sendError(response, 404, "Open /settings to edit Praxis preferences.");
      })
      .catch(() => response.destroy());
  });
}
