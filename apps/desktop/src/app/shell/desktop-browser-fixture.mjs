import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { after, before } from "node:test";
import { chromium } from "playwright";

const bundle = new URL("../../../dist/browser/", import.meta.url);
const desktopConfig = new URL("../../../src-tauri/tauri.conf.json", import.meta.url);
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const evidence = process.env.PRAXIS_UI_EVIDENCE_DIR;
const nonce = "cHJheGlzLWJyb3dzZXItdGVzdA==";

export function desktopBrowserSuite() {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!/^[\w.-]+$/.test(file)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(new URL(file, bundle));
      const headers = { "content-type": contentTypes[extname(file)] ?? "application/octet-stream" };
      if (file === "index.html") {
        headers["content-security-policy"] = policy;
      }
      response.writeHead(200, headers).end(file === "index.html"
        ? body.toString("utf8").replace("__TAURI_STYLE_NONCE__", nonce) : body);
    } catch {
      response.writeHead(404).end("Angular desktop build unavailable");
    }
  });
  let browser;
  let policy;

  before(async () => {
    const { app } = JSON.parse(await readFile(desktopConfig, "utf8"));
    policy = app.security.csp.replace(/style-src [^;]+/, (directive) => directive + " 'nonce-" + nonce + "'");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
    if (evidence) await mkdir(evidence, { recursive: true });
    console.log("Desktop bundle exercised in Chromium %s on %s %s", browser.version(), process.platform, process.arch);
  });

  after(async () => {
    await browser?.close();
    server.close();
  });

  async function open(t, viewport, observation, fragment = "", { initialize } = {}) {
    const context = await browser.newContext({ viewport });
    if (evidence) await context.tracing.start({ screenshots: true, snapshots: true });
    const violations = [];
    t.after(async () => {
      if (evidence) await context.tracing.stop({ path: join(evidence, observation + ".zip") });
      await context.close();
      assert.deepEqual(violations, [], "the production bundle complies with the desktop content security policy");
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" && /content security policy/i.test(message.text())) {
        violations.push(message.text());
      }
    });
    page.setDefaultTimeout(2_500);
    if (initialize) await page.addInitScript(initialize);
    const response = await page.goto("http://127.0.0.1:" + server.address().port + "/" + fragment);
    assert.equal(response?.status(), 200, "the desktop bundle serves its Angular entry point");
    return page;
  }

  async function capture(page, observation) {
    if (evidence) await page.screenshot({ path: join(evidence, observation + ".png") });
  }

  return { open, capture };
}
