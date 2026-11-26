import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const bundle = new URL("../../../../dist/browser/", import.meta.url);
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const traces = process.env.PRAXIS_UI_EVIDENCE_DIR;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[\w.-]+$/.test(file)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL(file, bundle));
    response.writeHead(200, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    response.writeHead(404).end("Angular desktop build unavailable");
  }
});
let browser;

const titles = [
  "Add catalog search filters", "Normalize warehouse API responses", "Cover checkout edge cases",
  "Review order export errors", "Document queue configuration", "Audit product filters",
  "Check keyboard navigation", "Cover empty search results", "Review checkout translations",
  "Verify inventory import behavior",
];
const longOutput = Array.from({ length: 100 }, (_, index) =>
  "Checking search and pagination fixture " + (index + 1) + ".").join("\n")
  + "\n" + "unbroken".repeat(120) + "\nFinished search fixture.";
const readOnly = { mode: "read_only", canTakeover: false, canGuide: false, canReturn: false, guidance: "none" };
const unknownUsage = { metering: "unknown", reason: "Native usage has not been reported." };

function projection(count) {
  const panes = titles.slice(0, count).map((title, index) => ({
    task: { id: "task_example_" + index, title },
    session: { id: "session_fixture_" + (index * 17 + 93), taskId: "task_example_" + index },
    ticket: "DEMO-" + (142 + index),
    highlighted: index === 1,
    runtime: {
      availability: "available",
      snapshot: {
        status: index === 1 ? "waiting_for_approval" : "running",
        output: {
          availability: "available",
          text: index === 0 ? longOutput : "Loaded task brief.\nReviewed fixture expectations.\nPreparing regression cases.",
          truncated: index === 0,
        },
      },
      usage: index === 0
        ? { metering: "reported", inputTokens: 32410, outputTokens: 1810, cost: { amount: 0.5, currency: "USD" } }
        : unknownUsage,
    },
    control: { ...readOnly, canTakeover: index === 0 },
    usageNotice: null,
  }));
  if (panes[2]) panes[2].runtime.snapshot.output.text = "";
  if (panes[3]) panes[3].runtime = { availability: "unavailable", reason: "Native worker is offline." };
  if (panes[4]) panes[4].runtime.snapshot.output = { availability: "unavailable", reason: "Native output buffer unavailable." };
  return { panes, association: { available: true, reason: null } };
}

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
  if (traces) await mkdir(traces, { recursive: true });
  console.log("Overview bundle exercised in Chromium " + browser.version() + " on " + process.platform + " " + process.arch);
});

after(async () => {
  await browser?.close();
  server.close();
});

async function open(t, viewport, observation, count) {
  const context = await browser.newContext({ viewport, locale: "en-US", colorScheme: "dark" });
  if (traces) await context.tracing.start({ screenshots: true, snapshots: true });
  t.after(async () => {
    if (traces) await context.tracing.stop({ path: join(traces, observation + ".zip") });
    await context.close();
  });
  await context.addInitScript(({ initial, readOnly }) => {
    window.isTauri = true;
    window.overviewFixture = { projection: initial, controls: [] };
    window.__TAURI_INTERNALS__ = {
      async invoke(command, args) {
        const fixture = window.overviewFixture;
        switch (command) {
          case "host_status": return { stage: "ready", nodeVersion: "24.22.3" };
          case "read_overview": return fixture.projection;
          case "control_session": {
            const request = args.request;
            fixture.controls.push(request);
            const pane = fixture.projection.panes.find((item) => item.session.id === request.sessionId);
            if (request.operation !== "takeover" || !pane?.control.canTakeover) {
              throw { code: "denied", message: "This fixture does not grant control." };
            }
            pane.control = { ...readOnly, mode: "manual", canGuide: true, canReturn: true };
            return pane.control;
          }
          default: throw new Error("Unexpected fixture IPC command " + command);
        }
      },
    };
  }, { initial: projection(count), readOnly });
  const page = await context.newPage();
  page.setDefaultTimeout(3_000);
  const response = await page.goto("http://127.0.0.1:" + server.address().port + "/#/overview");
  assert.equal(response?.status(), 200, "the desktop bundle serves its Angular entry point");
  await page.getByRole("heading", { level: 1, name: "Overview", exact: true }).waitFor();
  await page.locator("praxis-overview").evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  return page;
}

function workers(page) {
  return page.getByRole("region", { name: "Session panes" }).getByRole("article");
}

async function updateProjection(page, next) {
  await page.evaluate((next) => { window.overviewFixture.projection = next; }, next);
}

async function screenshot(page, name) {
  if (traces) await page.screenshot({ path: join(traces, name + ".png"), animations: "disabled" });
}

async function assertNoHorizontalOverflow(page) {
  assert.equal(await page.evaluate(() => {
    const main = document.querySelector("main");
    return main.scrollWidth <= main.clientWidth && document.documentElement.scrollWidth <= innerWidth;
  }), true, "Overview and its workspace fit horizontally");
}

test("desktop gives one loaded worker prominence and preserves its focused session controls", async (t) => {
  const page = await open(t, { width: 1280, height: 800 }, "overview-desktop", 4);
  const panes = workers(page);
  const first = panes.nth(0);
  const second = panes.nth(1);
  await panes.nth(3).waitFor();
  assert.equal(await panes.count(), 4);
  const collapsed = await first.boundingBox();
  assert.equal((await second.boundingBox()).y, collapsed.y, "workers share the default desktop row");
  await screenshot(page, "overview-several");
  const firstToggle = first.getByRole("button", { expanded: false });
  const secondToggle = second.getByRole("button", { expanded: false });
  await firstToggle.press("Enter");
  await first.getByRole("button", { expanded: true }).waitFor();
  const [prominent, neighbor] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  assert.ok(prominent.width > collapsed.width, "expanded worker gains horizontal prominence");
  assert.ok(prominent.x + prominent.width <= neighbor.x && prominent.y === neighbor.y,
    "a collapsed worker remains beside the featured pane on desktop");
  assert.equal(await first.getByRole("button", { expanded: true }).evaluate((node) => node === document.activeElement), true);
  const expandControl = first.getByRole("button", { name: "Take over" });
  await expandControl.waitFor();
  assert.equal(await second.getByRole("button", { name: "Take over" }).count(), 0);
  await first.getByText("Input tokens", { exact: true }).waitFor();
  await first.getByText("32,410", { exact: true }).waitFor();
  await first.getByText("Output tokens", { exact: true }).waitFor();
  await first.getByText("1,810", { exact: true }).waitFor();
  await first.getByText("0.5 USD", { exact: true }).waitFor();
  await first.getByText("Earlier output omitted.", { exact: true }).waitFor();
  assert.equal(await first.getAttribute("data-session-id"), projection(4).panes[0].session.id);
  await first.getByText(projection(4).panes[0].session.id, { exact: true }).waitFor();
  await assertNoHorizontalOverflow(page);
  await screenshot(page, "overview-expanded");

  const output = first.getByLabel("Session output");
  assert.equal(await output.textContent(), longOutput, "output uses the bounded bridge excerpt");
  await output.press("End");
  await page.waitForFunction((node) => node.scrollTop > 0
    && Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1, await output.elementHandle());
  assert.ok(await output.evaluate((node) => node.scrollWidth <= node.clientWidth),
    "long unbroken text wraps within the terminal");
  await screenshot(page, "overview-output-end");

  await expandControl.click();
  const guide = first.getByRole("button", { name: "Send guidance" });
  await guide.waitFor();
  await first.getByRole("button", { name: "Return control" }).waitFor();
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.locator("main").evaluate((node) => { node.scrollTop = 0; });
  const [guideBox, workspace] = await Promise.all([guide.boundingBox(), page.locator("main").boundingBox()]);
  assert.ok(guideBox.y + guideBox.height <= workspace.y + workspace.height,
    "manual guidance remains visible at the default packaged window size");
  await screenshot(page, "overview-guide-desktop");
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.deepEqual(await page.evaluate(() => window.overviewFixture.controls), [
    { operation: "takeover", sessionId: projection(4).panes[0].session.id },
  ]);

  await secondToggle.press("Space");
  await second.getByText(unknownUsage.reason, { exact: true }).waitFor();
  assert.equal(await panes.getByRole("button", { expanded: true }).count(), 1);
  assert.equal(await first.getByRole("button", { name: "Return control" }).count(), 0);
  await screenshot(page, "overview-unknown-usage");
  assert.equal(await second.getByRole("button", { expanded: true }).evaluate((node) => node === document.activeElement), true);
  assert.ok(await second.evaluate((node) => Number.parseFloat(getComputedStyle(node).transitionDuration)) > 0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await second.evaluate((node) => getComputedStyle(node).transitionDuration), "0s");
  assert.equal(await page.locator("praxis-overview").evaluate((node) => getComputedStyle(node).animationName), "none");
});

test("ten panes show bridge identities, status and explicit output states while manager activity moves and clears", async (t) => {
  const page = await open(t, { width: 1280, height: 800 }, "overview-projection", 1);
  const panes = workers(page);
  await panes.first().waitFor();
  assert.equal(await panes.count(), 1);
  await screenshot(page, "overview-one");
  const next = projection(10);
  await updateProjection(page, next);
  await panes.nth(9).waitFor();
  assert.equal(await panes.count(), 10);
  const ids = await panes.evaluateAll((articles) => articles.map((article) => article.dataset.sessionId));
  assert.deepEqual(ids, next.panes.map((pane) => pane.session.id));
  for (const [index, pane] of next.panes.entries()) {
    await panes.nth(index).getByRole("heading", { name: pane.task.title, exact: true }).waitFor();
    await panes.nth(index).getByText(pane.ticket, { exact: true }).waitFor();
  }
  await panes.nth(1).getByText(/^waiting for approval$/i).waitFor();
  await panes.nth(2).getByText("No session output available yet.", { exact: true }).waitFor();
  await panes.nth(3).getByText("Native worker is offline.", { exact: true }).waitFor();
  await panes.nth(4).getByText("Native output buffer unavailable.", { exact: true }).waitFor();
  const marker = panes.getByText("Manager activity", { exact: true });
  await marker.waitFor();
  assert.equal(await panes.nth(1).getByText("Manager activity", { exact: true }).count(), 1);
  await assertNoHorizontalOverflow(page);
  await screenshot(page, "overview-ten");
  await panes.nth(9).getByRole("button", { expanded: false }).scrollIntoViewIfNeeded();
  await screenshot(page, "overview-ten-tail");
  const markedElsewhere = structuredClone(next);
  markedElsewhere.panes[1].highlighted = false;
  markedElsewhere.panes[5].highlighted = true;
  await updateProjection(page, markedElsewhere);
  await panes.nth(5).getByText("Manager activity", { exact: true }).waitFor();
  assert.equal(await marker.count(), 1);
  markedElsewhere.panes[5].highlighted = false;
  await updateProjection(page, markedElsewhere);
  await marker.waitFor({ state: "hidden" });
  await updateProjection(page, projection(0));
  await page.getByRole("status").filter({ hasText: "No native session assignments are registered." }).waitFor();
  assert.equal(await panes.count(), 0);
});

test("360-pixel Overview keeps panes, scoped controls and command bar operable", async (t) => {
  const page = await open(t, { width: 360, height: 620 }, "overview-narrow", 10);
  const panes = workers(page);
  await panes.nth(9).waitFor();
  const [first, second] = await Promise.all([panes.nth(0).boundingBox(), panes.nth(1).boundingBox()]);
  assert.equal(first.x, second.x);
  assert.equal(first.width, second.width);
  assert.ok(first.y + first.height <= second.y, "the narrow grid is a single column");
  await assertNoHorizontalOverflow(page);
  await screenshot(page, "overview-narrow");
  await panes.first().getByRole("button", { expanded: false }).press("Enter");
  await panes.first().getByRole("button", { name: "Take over" }).waitFor();
  assert.equal(await panes.first().getByRole("button", { expanded: true }).evaluate((node) => node === document.activeElement), true);
  await screenshot(page, "overview-narrow-expanded");
  await panes.first().getByRole("button", { name: "Take over" }).scrollIntoViewIfNeeded();
  await screenshot(page, "overview-narrow-controls");
  await assertNoHorizontalOverflow(page);
  await panes.nth(9).getByRole("button", { expanded: false }).scrollIntoViewIfNeeded();
  const command = await page.getByRole("form", { name: "Command bar" }).boundingBox();
  assert.ok(command.y + command.height <= page.viewportSize().height);
  assert.ok(await page.locator("main").evaluate((node) => node.scrollTop > 0), "the workspace scrolls to the tenth worker");
  await screenshot(page, "overview-narrow-tenth");
  const last = panes.nth(9);
  await last.getByRole("button", { expanded: false }).press("Enter");
  const lastToggle = last.getByRole("button", { expanded: true });
  await lastToggle.waitFor();
  assert.equal(await lastToggle.evaluate((node) => node === document.activeElement), true);
  const [focused, workspace] = await Promise.all([lastToggle.boundingBox(), page.locator("main").boundingBox()]);
  assert.ok(focused.y >= workspace.y && focused.y + focused.height <= workspace.y + workspace.height,
    "the keyboard-focused disclosure stays visible when a scrolled pane expands");
  await screenshot(page, "overview-narrow-tenth-expanded");
});
