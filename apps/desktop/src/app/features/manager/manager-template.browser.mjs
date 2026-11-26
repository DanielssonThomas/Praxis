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

function focused(locator) {
  return locator.evaluate((element) => element === document.activeElement);
}

async function screenshot(page, name) {
  if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`) });
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
const narrow = { width: 360, height: 620 };

test("a dismissed resource stays dismissed when a later snapshot repeats it", async (t) => {
  const page = await open(t, wide, "manager-dismissal");
  await unlock(page);
  await page.getByRole("button", { name: "Lock manager" }).waitFor();
  await command(page, "Review fixture work");
  const card = page.getByRole("article", { name: task.task.title });
  await emit(page, "Here is the current fixture work.", { resources: [task, worker] });
  await card.getByRole("button", { name: "Dismiss" }).press("Enter");
  await card.waitFor({ state: "hidden" });
  const workerSelector = page.getByRole("button", { name: /Worker session session_fixture/ });
  assert.equal(await focused(workerSelector), true);
  assert.equal(await page.getByText(task.task.title, { exact: true }).count(), 0);
  await emit(page, "The fixture work was updated.", { resources: [worker, task] });
  assert.equal(await page.getByText(task.task.title, { exact: true }).count(), 0, "dismissed resource must stay hidden after republishing");
  await emit(page, "The fixture work is complete.", { status: "completed", resources: [worker, task] });
  await page.evaluate(() => window.managerFixture.finish());
  assert.equal(await page.getByText(task.task.title, { exact: true }).count(), 0);
  assert.equal(await workerSelector.getAttribute("aria-expanded"), "false");

  await command(page, "Review this task again in a new turn.");
  await emit(page, "The fixture task was referenced in this turn.", { resources: [task] });
  await card.waitFor();
  await card.getByRole("button", { name: "Dismiss" }).press("Enter");
  await card.waitFor({ state: "hidden" });
  assert.match(await page.evaluate(() => document.activeElement.textContent), /referenced in this turn/);
});

for (const viewport of [wide, narrow]) {
  test(`Manager start and long conversation fit ${viewport.width} × ${viewport.height}`, async (t) => {
    const page = await open(t, viewport, `manager-layout-${viewport.width}`);
    const form = page.getByRole("form", { name: "Open Manager" });
    const start = page.getByRole("region", { name: "What are we working on?" });
    const log = page.getByRole("log", { name: "Manager conversation" });
    const main = page.getByRole("main");
    const field = page.getByRole("textbox", { name: "Command", exact: true });
    await form.waitFor();
    assert.equal(await start.count(), 0);
    await unlock(page);
    await start.waitFor();
    const [workspace, hero] = await Promise.all([main.boundingBox(), start.boundingBox()]);
    assert.ok(workspace && hero);
    assert.ok(Math.abs(hero.x + hero.width / 2 - viewport.width / 2) < 8, "start state is centered horizontally");
    assert.ok(Math.abs(hero.y + hero.height / 2 - workspace.y - workspace.height / 2) < 60, "start state is centered in the workspace");
    await page.getByText("Context window and compaction unavailable").waitFor();
    assert.equal(await log.count(), 0);
    await screenshot(page, `manager-empty-${viewport.width}`);

    await command(page, "Describe the fixture workload.");
    await page.getByText("Waiting for the manager…", { exact: true }).waitFor();
    const long = "Long fixture output " + "x".repeat(8_000);
    await emit(page, long);
    await page.getByText("Receiving manager output…", { exact: true }).waitFor();
    const message = log.getByText(long, { exact: true });
    const bounds = await message.boundingBox();
    assert.ok(bounds && bounds.width <= 784 && bounds.x + bounds.width <= viewport.width);
    assert.equal(await message.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await log.focus();
    assert.equal(await focused(log), true);
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.querySelector("main").scrollTop > 0);
    await field.focus();
    assert.equal(await focused(field), true);
    const commandBounds = await field.boundingBox();
    assert.ok(commandBounds && commandBounds.y + commandBounds.height <= viewport.height);
    await screenshot(page, `manager-streamed-${viewport.width}`);
  });
}

test("Manager keeps setup-required distinct from the locked form", async (t) => {
  const page = await open(t, narrow, "manager-setup-required", { setupRequired: true });
  const form = page.getByRole("form", { name: "Open Manager" });
  await form.waitFor();
  assert.equal(await page.getByText("Configure the local operator and named Hermes manager.").count(), 0);
  await unlock(page);
  await page.getByText("Configure the local operator and named Hermes manager.", { exact: true }).waitFor();
  await form.waitFor();
  assert.equal(await page.getByRole("button", { name: "Lock manager" }).count(), 0);
});

test("related-work selectors open, switch and restore focus with the keyboard", async (t) => {
  const page = await open(t, narrow, "manager-card-keyboard");
  await unlock(page);
  await page.getByRole("button", { name: "Lock manager" }).waitFor();
  await command(page, "Find related fixture work.");
  const resources = [task, worker, { kind: "unavailable", resource: "task" }, { kind: "unavailable", resource: "session" }];
  await emit(page, "Four references came from the bridge.", { resources });
  const related = page.getByRole("complementary", { name: "Related work" });
  const taskSelector = related.getByRole("button", { name: task.task.title });
  const workerSelector = related.getByRole("button", { name: /Worker session session_fixture/ });
  const taskPanel = related.getByRole("article", { name: task.task.title });
  const workerPanel = related.getByRole("article", { name: "Worker session" });
  await taskPanel.waitFor();
  assert.equal(await taskSelector.getAttribute("aria-expanded"), "true");
  const panelId = await taskSelector.getAttribute("aria-controls");
  assert.equal(await taskPanel.evaluate((node) => node.parentElement.id), panelId);
  await taskSelector.press("Escape");
  await taskPanel.waitFor({ state: "hidden" });
  assert.equal(await focused(taskSelector), true);
  await emit(page, "The same four references came back.", { resources });
  assert.equal(await taskSelector.getAttribute("aria-expanded"), "false");
  await page.keyboard.press("Enter");
  await taskPanel.waitFor();
  await page.keyboard.press("Tab");
  assert.equal(await focused(workerSelector), true);
  await page.keyboard.press("Space");
  await workerPanel.waitFor();
  await taskPanel.waitFor({ state: "hidden" });
  assert.equal(await workerSelector.getAttribute("aria-expanded"), "true");
  await workerPanel.getByText(worker.session.id, { exact: true }).waitFor();
  await workerPanel.getByText("running", { exact: true }).waitFor();
  const [workspace, detail] = await Promise.all([page.getByRole("main").boundingBox(), workerPanel.boundingBox()]);
  assert.ok(workspace && detail && detail.y + detail.height <= workspace.y + workspace.height);
  assert.equal(await focused(workerSelector), true);
  await screenshot(page, "manager-available-card");
  await workerPanel.getByRole("button", { name: "Close details" }).press("Enter");
  await workerPanel.waitFor({ state: "hidden" });
  assert.equal(await focused(workerSelector), true);

  const unavailable = related.getByRole("button", { name: "Task unavailable", exact: true });
  await unavailable.press("Enter");
  const missingPanel = related.getByRole("article", { name: "Task unavailable" });
  await missingPanel.getByText("The Manager connection could not resolve this reference.").waitFor();
  await screenshot(page, "manager-unavailable-card");
  const unavailableWorker = related.getByRole("button", { name: "Worker session unavailable" });
  await unavailableWorker.press("Enter");
  await related.getByRole("article", { name: "Worker session unavailable" }).waitFor();
  await missingPanel.waitFor({ state: "hidden" });
});

test("Manager retains history and the active turn across command navigation and reconnect", async (t) => {
  const history = [{ role: "user", text: "Earlier fixture prompt." }, { role: "assistant", text: "Earlier fixture answer." }];
  const page = await open(t, wide, "manager-reconnect", { history });
  await unlock(page);
  const log = page.getByRole("log");
  for (const { text } of history) await log.getByText(text, { exact: true }).waitFor();

  const prompt = "Continue the same fixture turn.";
  await command(page, prompt);
  await emit(page, "Partial fixture response.");
  assert.equal(await page.getByText(/Turn usage/).count(), 0);
  await command(page, "/o");
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor();
  await command(page, "/m");
  await page.getByRole("heading", { name: "Manager", level: 1 }).waitFor();
  await log.getByText("Partial fixture response.", { exact: true }).waitFor();
  await page.evaluate(() => window.managerFixture.disconnect());
  await page.getByText("The manager stream was interrupted. Reconnect to continue.").waitFor();
  const reconnect = page.getByRole("button", { name: "Reconnect", exact: true });
  await reconnect.press("Enter");
  await page.getByText("Waiting for the manager…", { exact: true }).waitFor();
  const requests = await page.evaluate(() => window.managerFixture.requests());
  assert.equal(requests.length, 2);
  assert.ok(requests[0].turnId);
  assert.equal(requests[0].prompt, prompt);
  assert.deepEqual(requests[1], requests[0]);
  await emit(page, "Final fixture response.", {
    status: "completed",
    resources: [],
    usage: { metering: "reported", inputTokens: 0, outputTokens: 12 },
  });
  await page.evaluate(() => window.managerFixture.finish());
  await page.getByText("Turn usage · 0 input tokens · 12 output tokens", { exact: true }).waitFor();
  assert.equal(await reconnect.count(), 0);
  assert.equal(await log.getByText(prompt, { exact: true }).count(), 1);
  assert.equal(await log.getByText("Partial fixture response.", { exact: true }).count(), 0);
  assert.equal(await log.getByRole("complementary", { name: "Related work" }).count(), 0);
});
