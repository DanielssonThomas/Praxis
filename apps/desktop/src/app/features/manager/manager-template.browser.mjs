import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const bundle = new URL("../../../../dist/browser/", import.meta.url);
const evidence = process.env.PRAXIS_UI_EVIDENCE_DIR;
let browser;

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
  if (evidence) await mkdir(evidence, { recursive: true });
  console.log(`Manager bundle exercised in Chromium ${browser.version()} on ${process.platform} ${process.arch}`);
});

after(async () => { await browser?.close(); });

async function open(t, viewport, observation, options = {}) {
  const context = await browser.newContext({ viewport, colorScheme: "dark" });
  if (evidence) await context.tracing.start({ screenshots: true, snapshots: true });
  t.after(async () => {
    if (evidence) await context.tracing.stop({ path: join(evidence, `${observation}.zip`) });
    await context.close();
  });
  await context.route("http://127.0.0.1/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const asset = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!/^[\w.-]+$/.test(asset) || asset.startsWith(".")) {
      await route.abort();
      return;
    }
    await route.fulfill({ path: fileURLToPath(new URL(asset, bundle)) });
  });
  await context.addInitScript(({ history = [], setupRequired = false }) => {
    const callbacks = new Map();
    const streams = [];
    let callbackId = 0;
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) {
        callbacks.set(++callbackId, callback);
        return callbackId;
      },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args) {
        switch (command) {
          case "host_status": return { stage: "ready", nodeVersion: "24.22.3" };
          case "unlock_manager":
            if (setupRequired) throw { code: "setup_required", message: "Configure the local operator and named Hermes manager." };
            return history;
          case "lock_manager": return;
          case "manager_turn": {
            return new Promise((resolve, reject) => {
              streams.push({ request: args.request, id: args.output.id, index: 0, resolve, reject });
            });
          }
          default: throw new Error(`Unexpected fixture command: ${command}`);
        }
      },
    };
    // Fixtures supply the same IPC frames as Tauri, without a native host or an operator credential.
    window.managerFixture = {
      requests: () => streams.map(({ request }) => request),
      emit(message, stream = streams.length - 1) {
        const current = streams[stream];
        callbacks.get(current.id)({ index: current.index++, message });
      },
      finish() {
        const current = streams.at(-1);
        callbacks.get(current.id)({ index: current.index, end: true });
        current.resolve(null);
      },
      disconnect() {
        streams.at(-1).reject({ code: "interrupted", message: "The manager stream was interrupted. Reconnect to continue." });
      },
    };
  }, options);
  const page = await context.newPage();
  page.setDefaultTimeout(3_000);
  const response = await page.goto("http://127.0.0.1/");
  assert.equal(response?.status(), 200);
  return page;
}

async function unlock(page) {
  const form = page.getByRole("form", { name: "Open Manager" });
  await form.getByLabel("Operator token").fill("fixture-token");
  await form.getByRole("button", { name: "Open manager", exact: true }).press("Enter");
}

async function command(page, value) {
  const field = page.getByRole("textbox", { name: "Command", exact: true });
  await field.fill(value);
  await field.press("Enter");
}

async function emit(page, text, { resources, status = "running", usage = { metering: "unknown", reason: "unsupported" } } = {}) {
  await page.evaluate((message) => window.managerFixture.emit(message), {
    kind: "snapshot", snapshot: { status, output: { availability: "available", text, truncated: false } }, usage, resources,
  });
  await page.getByRole("log").getByText(text, { exact: true }).waitFor();
}

const task = { kind: "task", task: { id: "task_fixture", title: "Fixture delivery" } };
const worker = { kind: "session", session: { id: "session_fixture", taskId: task.task.id }, status: "running" };
const wide = { width: 1280, height: 800 };

test("a dismissed resource stays dismissed when a later snapshot repeats it", async (t) => {
  const page = await open(t, wide, "manager-dismissal");
  await unlock(page);
  await page.getByRole("button", { name: "Lock manager" }).waitFor();
  await command(page, "Review fixture work");
  const card = page.getByRole("article", { name: task.task.title });
  await emit(page, "Here is the current fixture work.", { resources: [task, worker] });
  await card.getByRole("button", { name: "Dismiss" }).press("Enter");
  await card.waitFor({ state: "hidden" });
  assert.equal(await page.getByText(task.task.title, { exact: true }).count(), 0);
  await emit(page, "The fixture work was updated.", { resources: [worker, task] });
  assert.equal(await page.getByText(task.task.title, { exact: true }).count(), 0, "dismissed resource must stay hidden after republishing");
  await emit(page, "The fixture work is complete.", { status: "completed", resources: [worker, task] });
  await page.evaluate(() => window.managerFixture.finish());
  assert.equal(await page.getByText(task.task.title, { exact: true }).count(), 0);
  assert.ok(await page.getByText("Worker session", { exact: true }).count());
});
