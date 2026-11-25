import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { OperationalStore } from "@praxis/state";
import { populateReports } from "../fixtures/reports.mjs";

let browser;
let host;
let directory;
let address;
let reportDay;
const token = "reports-browser-operator-fixture-value";

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "praxis-shell-browser-"));
  const database = join(directory, "operational.sqlite");
  const store = new OperationalStore(database);
  reportDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  populateReports(store, reportDay);
  store.close();
  host = spawn(process.execPath, ["packages/shell/dist/cli.js"], {
    env: {
      ...process.env, PRAXIS_PORT: "0", PRAXIS_CONFIG_FILE: join(directory, "settings.json"),
      PRAXIS_REPORTS_DATABASE: database, PRAXIS_OPERATOR_TOKEN_DIGEST: createHash("sha256").update(token).digest("hex"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const log = await Promise.race([
    once(host.stdout, "data").then(([value]) => value.toString()),
    once(host, "exit").then(([code]) => { throw new Error(`Praxis exited before listening (${code})`); }),
  ]);
  address = /http:\/\/127\.0\.0\.1:\d+\//.exec(log)?.[0];
  assert.ok(address, "Praxis printed its loopback address");
  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
});

after(async () => {
  await browser?.close();
  if (host?.exitCode === null && host.signalCode === null) {
    host.kill();
    await once(host, "exit");
  }
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

async function openPage(t, viewport) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(3_000);
  t.after(() => page.close());
  await page.goto(address);
  return page;
}

async function command(page, value) {
  const field = page.getByRole("textbox", { name: "Command", exact: true });
  await field.fill(value);
  await field.press("Enter");
}

async function navigate(page, name) {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
}

async function heading(page, name) {
  await page.getByRole("heading", { level: 1, name, exact: true }).waitFor();
}

async function assertLayout(page) {
  const [header, content, bar, input] = await Promise.all([
    page.locator("#shell-header").boundingBox(),
    page.locator("#workspace").boundingBox(),
    page.locator("#command-bar").boundingBox(),
    page.getByRole("textbox", { name: "Command", exact: true }).boundingBox(),
  ]);
  assert.ok(header && content && bar && input, "core shell regions are visible");
  assert.ok(header.y + header.height <= content.y, "menu stays above workspace");
  assert.ok(content.y + content.height <= bar.y, "command bar stays below workspace");
  assert.ok(input.y >= bar.y && input.y + input.height <= page.viewportSize().height, "command remains in viewport");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

test("the command bar stays visible without overlap at desktop and narrow sizes", async (t) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 620 }]) {
    const page = await openPage(t, viewport);
    await heading(page, "Manager");
    await assertLayout(page);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("navigation").waitFor();
    await assertLayout(page);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("navigation").isVisible(), false);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await heading(page, "Overview");
    assert.equal(await page.getByRole("navigation").isVisible(), false);
    await assertLayout(page);
  }
});

test("full, short, help and unknown commands resolve without network requests", async (t) => {
  const page = await openPage(t, { width: 960, height: 720 });
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  for (const [spelling, view] of [
    ["/overview", "Overview"], ["/manager", "Manager"], ["/o", "Overview"], ["/m", "Manager"],
  ]) {
    await command(page, spelling);
    await heading(page, view);
  }
  for (const spelling of ["/help", "/h"]) {
    await command(page, spelling);
    await page.getByRole("status").getByText(/\/manager.*\/overview.*\/help/).waitFor();
  }
  await command(page, "/unknown");
  await page.getByRole("status").getByText(/Unknown command.*\/help/).waitFor();
  assert.deepEqual(requests, []);
});

test("menu and history switches preserve both views and their command drafts", async (t) => {
  const page = await openPage(t, { width: 960, height: 720 });
  const input = page.getByRole("textbox", { name: "Command", exact: true });
  const manager = await page.locator('[data-view="manager"]').elementHandle();
  const overview = await page.locator('[data-view="overview"]').elementHandle();
  for (const panel of [manager, overview]) {
    await panel.evaluate((element) => {
      const child = document.createElement("div");
      child.style.blockSize = "1600px";
      element.append(child);
    });
  }
  await manager.evaluate((element) => { element.scrollTop = 120; });
  await input.fill("Manager draft");
  await navigate(page, "Overview");
  await heading(page, "Overview");
  await overview.evaluate((element) => { element.scrollTop = 80; });
  await input.fill("Overview draft");
  await navigate(page, "Manager");
  await heading(page, "Manager");
  assert.equal(await input.inputValue(), "Manager draft");
  assert.equal(await manager.evaluate((element) => element.scrollTop), 120);
  await page.goBack();
  await heading(page, "Overview");
  assert.equal(await input.inputValue(), "Overview draft");
  assert.equal(await overview.evaluate((element) => element.scrollTop), 80);
  assert.equal(await manager.evaluate((element) => element === document.querySelector('[data-view="manager"]')), true);
  assert.equal(await overview.evaluate((element) => element === document.querySelector('[data-view="overview"]')), true);
});

test("the settings route composes the local editor within the permanent shell", async (t) => {
  const page = await openPage(t, { width: 360, height: 620 });
  await command(page, "/s");
  const frame = page.frameLocator('iframe[title="Praxis settings"]');
  await frame.getByRole("heading", { name: "Praxis settings" }).waitFor();
  const applyAxiom = frame.getByRole("checkbox", { name: "Apply Axiom policy" });
  await applyAxiom.uncheck();
  await frame.getByRole("button", { name: "Save settings" }).click();
  await frame.getByRole("status").getByText("Settings saved.").waitFor();
  await assertLayout(page);
  await command(page, "/m");
  await heading(page, "Manager");
  await command(page, "/settings");
  await frame.getByRole("heading", { name: "Praxis settings" }).waitFor();
  assert.equal(await applyAxiom.isChecked(), false);
  await assertLayout(page);
});

test("local reports filter the active Chart.js view, preserve preferences and clear only report history", async (t) => {
  const page = await openPage(t, { width: 1200, height: 900 });
  const endpoint = new URL("/api/reports", address);
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(new URL("/api/reports/clear", address), {
    method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: "http://localhost:3129" },
  })).status, 403);
  assert.equal((await fetch(new URL("/api/reports/clear", address), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`, Origin: endpoint.origin, "Content-Type": "application/json",
    },
    body: JSON.stringify({ confirmed: true }),
  })).status, 409);
  await command(page, "/r");
  await heading(page, "Reports");
  await page.getByRole("form", { name: "Open Reports" }).getByLabel("Operator token").fill(token);
  await page.getByRole("button", { name: "Open reports" }).click();
  const merged = page.getByRole("img", { name: "PRs merged (recorded) by day (UTC)" });
  await merged.waitFor();
  const point = await merged.evaluate((canvas, day) => {
    const chart = window.Chart.getChart(canvas);
    if (chart.data.labels.length !== 30) throw new Error("Initial chart did not include 30 days");
    const index = chart.data.labels.indexOf(day);
    const { x, y } = chart.getDatasetMeta(0).data[index];
    return { x, y };
  }, reportDay);
  await merged.hover({ position: point });
  await merged.evaluate((canvas, day) => {
    const chart = window.Chart.getChart(canvas);
    if (chart.tooltip.title[0] !== day || chart.tooltip.dataPoints[0].parsed.y !== 1) {
      throw new Error("Chart.js tooltip did not expose the selected day and measured value");
    }
  }, reportDay);

  await page.getByLabel("Time range").selectOption("7");
  await page.waitForFunction(() => window.Chart.getChart(document.querySelector(
    'canvas[aria-label="PRs merged (recorded) by day (UTC)"]',
  ))?.data.labels.length === 7);
  assert.equal(await page.getByRole("button", { name: "Export report JSON" }).isEnabled(), false);
  await page.getByText("Report preferences", { exact: true }).click();
  await page.getByRole("checkbox", { name: "PRs merged (recorded)", exact: true }).uncheck();
  assert.equal(await merged.count(), 0);
  await page.getByRole("checkbox", { name: "Allow report export" }).check();
  await page.getByRole("checkbox", { name: "Allow clearing report history" }).check();
  await page.getByLabel("Report retention").selectOption("7");
  await page.getByRole("button", { name: "Save report preferences" }).click();
  await page.locator("#reports-status").getByText("Report preferences saved.").waitFor();
  assert.equal(await page.locator('#reports-range option[value="30"]').isDisabled(), true);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export report JSON" }).click();
  const download = await downloading;
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(exported.days, 7);
  assert.equal(exported.buckets.find(({ day }) => day === reportDay).metrics.costUsd, 0);
  assert.equal(exported.buckets[0].metrics.tokens, null);
  assert.equal(Object.hasOwn(exported.buckets[0].metrics, "prsMerged"), false);

  await command(page, "/settings");
  const frame = page.frameLocator('iframe[title="Praxis settings"]');
  await frame.getByRole("checkbox", { name: "Apply Axiom policy" }).check();
  await frame.getByRole("button", { name: "Save settings" }).click();
  await frame.getByRole("status").getByText("Settings saved.").waitFor();
  await page.reload();
  await command(page, "/reports");
  await page.getByRole("form", { name: "Open Reports" }).getByLabel("Operator token").fill(token);
  await page.getByRole("button", { name: "Open reports" }).click();
  await page.getByRole("img", { name: "Reported tokens by day (UTC)" }).waitFor();
  assert.equal(await merged.count(), 0);
  assert.equal(await page.getByLabel("Time range").inputValue(), "7");
  await page.getByText("Report preferences", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear report history" }).click();
  await page.locator("#reports-status").getByText("Report history cleared.").waitFor();
  assert.equal(await page.getByRole("img", { name: "Reported tokens by day (UTC)" }).count(), 0);
  const audit = new OperationalStore(join(directory, "operational.sqlite"));
  try {
    assert.ok(audit.getEvent("event_known_usage"), "clearing reports preserves recorded operational usage events");
  } finally {
    audit.close();
  }
  await page.getByRole("checkbox", { name: "Show collected metrics in reports" }).uncheck();
  await page.getByRole("button", { name: "Save report preferences" }).click();
  await page.getByText("Report collection is paused.", { exact: false }).waitFor();
  await assertLayout(page);
});

test("Manager sends plain text and reconnects the same turn after unblocking navigation", async (t) => {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  t.after(() => page.close());
  const requests = [];
  const bearer = "fixture-browser-operator";
  await page.route(address, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace('data-manager="unavailable"', 'data-manager="available"');
    await route.fulfill({ response, body });
  });
  await page.route("**/api/manager/turn", async (route) => {
    const request = route.request();
    assert.equal(request.headers().authorization, `Bearer ${bearer}`);
    if (request.method() === "HEAD") {
      await route.fulfill({ status: 204 });
      return;
    }
    requests.push(request.postDataJSON());
    const status = requests.length === 1 ? "running" : "completed";
    const text = status === "running" ? "A partial manager reply" : "The complete manager reply.";
    await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({
      kind: "snapshot", runId: "run_browser_manager",
      snapshot: { status, output: { availability: "available", text, truncated: false } },
      usage: { metering: "reported", inputTokens: 8, outputTokens: 2 },
    }) + "\n" });
  });
  await page.goto(address);
  await page.getByRole("form", { name: "Open Manager" }).getByLabel("Operator token", { exact: true }).fill(bearer);
  await page.getByRole("button", { name: "Open manager", exact: true }).click();
  await page.getByRole("button", { name: "Lock manager", exact: true }).waitFor();
  await command(page, "Keep Case in the prompt.");
  await page.getByText("A partial manager reply", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reconnect", exact: true }).waitFor();

  await command(page, "/o");
  await heading(page, "Overview");
  await command(page, "/m");
  await heading(page, "Manager");
  await page.getByText("A partial manager reply", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByText("The complete manager reply.", { exact: true }).waitFor();
  await page.getByText(/window and compaction unavailable/).waitFor();
  await page.getByText(/8 input · 2 output tokens/).waitFor();

  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].prompt, "Keep Case in the prompt.");
  assert.equal(await page.getByText("Keep Case in the prompt.", { exact: true }).count(), 1);
  assert.equal(await page.evaluate((value) => [JSON.stringify(localStorage), JSON.stringify(sessionStorage)]
    .some((storage) => storage.includes(value)), bearer), false);
});

test("Manager displays authoritative resource cards and lets the operator expand and dismiss them", async (t) => {
  const page = await browser.newPage({ viewport: { width: 360, height: 620 } });
  page.setDefaultTimeout(3_000);
  t.after(() => page.close());
  await page.route(address, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response, body: (await response.text()).replace('data-manager="unavailable"', 'data-manager="available"'),
    });
  });
  await page.route("**/api/manager/turn", async (route) => {
    if (route.request().method() === "HEAD") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({
      kind: "snapshot", snapshot: { status: "completed", output: { availability: "available", text: "Here is the work.", truncated: false } },
      usage: { metering: "unknown" },
      resources: [
        { kind: "task", task: { schemaVersion: 1, id: "task_card", title: "Authoritative browser task" } },
        { kind: "session", session: { schemaVersion: 1, id: "session_card", taskId: "task_card" }, status: "running" },
        { kind: "unavailable", resource: "task" },
      ],
    }) + "\n" });
  });
  await page.goto(address);
  await page.getByRole("form", { name: "Open Manager" }).getByLabel("Operator token").fill("fixture-browser-operator");
  await page.getByRole("button", { name: "Open manager", exact: true }).click();
  await page.getByRole("button", { name: "Lock manager", exact: true }).waitFor();
  await command(page, "Show the work.");
  await page.getByText("Here is the work.", { exact: true }).waitFor();

  const task = page.getByRole("article", { name: "Authoritative browser task" });
  await task.waitFor();
  assert.equal(await task.getByText("task_card", { exact: true }).isVisible(), false);
  await task.getByText("Details", { exact: true }).click();
  await task.getByText("task_card", { exact: true }).waitFor();
  const worker = page.getByRole("article", { name: "Worker session" });
  await worker.getByText("running", { exact: true }).waitFor();
  const unavailable = page.getByText("Task unavailable", { exact: true });
  await unavailable.waitFor();
  await task.getByRole("button", { name: "Dismiss", exact: true }).click();
  await task.waitFor({ state: "detached" });
  await assertLayout(page);
});
