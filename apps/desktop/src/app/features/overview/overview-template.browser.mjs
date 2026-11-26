import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopBrowserSuite } from "../../shell/desktop-browser-fixture.mjs";

const { open, capture } = desktopBrowserSuite();

const titles = [
  "Add catalog search filters", "Normalize warehouse API responses", "Cover checkout edge cases",
  "Review order export errors", "Document queue configuration", "Audit product filters",
  "Check keyboard navigation", "Cover empty search results", "Review checkout translations",
  "Verify inventory import behavior", "Check delayed sync events",
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
  return { panes, page: { number: 1, count: 1 }, association: { available: true, reason: null } };
}

function installFixture({ initial, readOnly, pages }) {
  window.isTauri = true;
  window.overviewFixture = { projection: initial, controls: [], pages, readPages: [] };
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      const fixture = window.overviewFixture;
      switch (command) {
        case "host_status": return { stage: "ready", nodeVersion: "24.22.3" };
        case "read_overview": {
          const page = args?.request?.page ?? 1;
          fixture.readPages.push(page);
          const response = fixture.pages?.[page] ?? fixture.projection;
          if (fixture.holdPage === page) {
            fixture.holdPage = null;
            await new Promise((resolve) => { fixture.releaseRead = resolve; });
          }
          return response;
        }
        case "control_session": {
          const request = args.request;
          fixture.controls.push(request);
          const pane = fixture.projection.panes.find((item) => item.session.id === request.sessionId);
          if (request.operation === "guide" && pane?.control.canGuide) return pane.control;
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
}

async function openOverview(t, viewport, observation, count, pages) {
  const fixture = { initial: pages?.[1] ?? projection(count), readOnly, pages };
  const initialize = `(${installFixture})(${JSON.stringify(fixture)})`;
  const page = await open(t, viewport, observation, "#/overview", { initialize });
  page.setDefaultTimeout(3_000);
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

async function assertNoHorizontalOverflow(page) {
  assert.equal(await page.evaluate(() => {
    const main = document.querySelector("main");
    return main.scrollWidth <= main.clientWidth && document.documentElement.scrollWidth <= innerWidth;
  }), true, "Overview and its workspace fit horizontally");
}

test("a Codex Overview pane displays its own native identity and unavailable controls", async (t) => {
  const fixture = projection(1);
  const runId = "codex_fixture_native_run";
  const reason = "Codex does not support takeover, guidance, or handback.";
  Object.assign(fixture.panes[0], {
    worker: { runtime: "codex", runId },
    control: { ...readOnly, unavailableReason: reason },
  });
  const page = await openOverview(t, { width: 1120, height: 760 }, "overview-codex-worker", 1, { 1: fixture });
  const pane = workers(page).first();
  await pane.waitFor();
  assert.equal(await pane.getAttribute("data-worker-runtime"), "codex");
  assert.equal(await pane.getAttribute("data-session-id"), fixture.panes[0].session.id);
  assert.equal(await pane.locator("[data-status]").textContent(), "Running");
  assert.equal(await pane.getByLabel("Session output").textContent(), longOutput);
  await pane.getByRole("button", { name: /^Expand/ }).press("Enter");
  for (const text of ["Runtime", "Codex", "Native run", runId, "Input tokens", "32,410"]) {
    await pane.getByText(text, { exact: true }).waitFor();
  }
  assert.equal(await pane.locator("[data-control-unavailable]").textContent(), reason);
  assert.equal(await pane.getByRole("button", { name: /take over|send guidance|return control/i }).count(), 0);
});

test("desktop gives one loaded worker prominence and preserves its focused session controls", async (t) => {
  const page = await openOverview(t, { width: 1280, height: 800 }, "overview-desktop", 4);
  const panes = workers(page);
  const first = panes.nth(0);
  const second = panes.nth(1);
  await panes.nth(3).waitFor();
  assert.equal(await panes.count(), 4);
  const collapsed = await first.boundingBox();
  assert.equal((await second.boundingBox()).y, collapsed.y, "workers share the default desktop row");
  await capture(page, "overview-several");
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
  await capture(page, "overview-expanded");

  const output = first.getByLabel("Session output");
  assert.equal(await output.textContent(), longOutput, "output uses the bounded bridge excerpt");
  await output.press("End");
  await page.waitForFunction((node) => node.scrollTop > 0
    && Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) <= 1, await output.elementHandle());
  assert.ok(await output.evaluate((node) => node.scrollWidth <= node.clientWidth),
    "long unbroken text wraps within the terminal");
  await capture(page, "overview-output-end");

  await expandControl.click();
  const guide = first.getByRole("button", { name: "Send guidance" });
  const handback = first.getByRole("button", { name: "Return control" });
  await guide.waitFor();
  await handback.waitFor();
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.locator("main").evaluate((node) => { node.scrollTop = 0; });
  const [guideBox, handbackBox, workspace] = await Promise.all([
    guide.boundingBox(), handback.boundingBox(), page.locator("main").boundingBox(),
  ]);
  assert.ok(Math.max(guideBox.y + guideBox.height, handbackBox.y + handbackBox.height) <= workspace.y + workspace.height,
    "both manual controls fit above the dock at the default packaged window size");
  await capture(page, "overview-guide-desktop");
  const guidance = "Check the fixture search results.";
  await first.getByLabel("Manual guidance").fill(guidance);
  await guide.click();
  await first.getByText("Hermes accepted this guidance for delivery.", { exact: true }).waitFor();
  await page.setViewportSize({ width: 1280, height: 800 });
  const sessionId = projection(4).panes[0].session.id;
  assert.deepEqual(await page.evaluate(() => window.overviewFixture.controls), [
    { operation: "takeover", sessionId },
    { operation: "guide", sessionId, text: guidance },
  ]);

  await secondToggle.press("Space");
  await second.getByText(unknownUsage.reason, { exact: true }).waitFor();
  assert.equal(await panes.getByRole("button", { expanded: true }).count(), 1);
  assert.equal(await first.getByRole("button", { name: "Return control" }).count(), 0);
  await capture(page, "overview-unknown-usage");
  assert.equal(await second.getByRole("button", { expanded: true }).evaluate((node) => node === document.activeElement), true);
  assert.ok(await second.evaluate((node) => Number.parseFloat(getComputedStyle(node).transitionDuration)) > 0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await second.evaluate((node) => getComputedStyle(node).transitionDuration), "0s");
  assert.equal(await page.locator("praxis-overview").evaluate((node) => getComputedStyle(node).animationName), "none");
});

test("ten panes show bridge identities, status and explicit output states while manager activity moves and clears", async (t) => {
  const page = await openOverview(t, { width: 1280, height: 800 }, "overview-projection", 1);
  const panes = workers(page);
  await panes.first().waitFor();
  assert.equal(await panes.count(), 1);
  await capture(page, "overview-one");
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
  await capture(page, "overview-ten");
  await panes.nth(9).getByRole("button", { expanded: false }).scrollIntoViewIfNeeded();
  await capture(page, "overview-ten-tail");
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
  const page = await openOverview(t, { width: 360, height: 620 }, "overview-narrow", 10);
  const panes = workers(page);
  await panes.nth(9).waitFor();
  const [first, second] = await Promise.all([panes.nth(0).boundingBox(), panes.nth(1).boundingBox()]);
  assert.equal(first.x, second.x);
  assert.equal(first.width, second.width);
  assert.ok(first.y + first.height <= second.y, "the narrow grid is a single column");
  await assertNoHorizontalOverflow(page);
  await capture(page, "overview-narrow");
  await panes.first().getByRole("button", { expanded: false }).press("Enter");
  await panes.first().getByRole("button", { name: "Take over" }).waitFor();
  assert.equal(await panes.first().getByRole("button", { expanded: true }).evaluate((node) => node === document.activeElement), true);
  await capture(page, "overview-narrow-expanded");
  await panes.first().getByRole("button", { name: "Take over" }).scrollIntoViewIfNeeded();
  await capture(page, "overview-narrow-controls");
  await assertNoHorizontalOverflow(page);
  await panes.nth(9).getByRole("button", { expanded: false }).scrollIntoViewIfNeeded();
  const command = await page.getByRole("form", { name: "Command bar" }).boundingBox();
  assert.ok(command.y + command.height <= page.viewportSize().height);
  assert.ok(await page.locator("main").evaluate((node) => node.scrollTop > 0), "the workspace scrolls to the tenth worker");
  await capture(page, "overview-narrow-tenth");
  const last = panes.nth(9);
  await last.getByRole("button", { expanded: false }).press("Enter");
  const lastToggle = last.getByRole("button", { expanded: true });
  await lastToggle.waitFor();
  assert.equal(await lastToggle.evaluate((node) => node === document.activeElement), true);
  const [focused, workspace] = await Promise.all([lastToggle.boundingBox(), page.locator("main").boundingBox()]);
  assert.ok(focused.y >= workspace.y && focused.y + focused.height <= workspace.y + workspace.height,
    "the keyboard-focused disclosure stays visible when a scrolled pane expands");
  await capture(page, "overview-narrow-tenth-expanded");
});

test("Overview pages keep the eleventh worker reachable and discard a late first-page poll", async (t) => {
  const pageOne = { ...projection(10), page: { number: 1, count: 2 } };
  const pageTwo = { ...projection(11), page: { number: 2, count: 2 }, panes: [projection(11).panes[10]] };
  const page = await openOverview(t, { width: 360, height: 620 }, "overview-pages", 10, { 1: pageOne, 2: pageTwo });
  const pager = page.getByRole("navigation", { name: "Overview pages" });
  const previous = pager.getByRole("button", { name: "Previous", exact: true });
  const next = pager.getByRole("button", { name: "Next", exact: true });
  await pager.getByText("Page 1 of 2", { exact: true }).waitFor();
  assert.equal(await previous.getAttribute("aria-disabled"), "true");
  assert.equal(await next.getAttribute("aria-disabled"), "false");
  assert.equal(await workers(page).count(), 10);
  await workers(page).first().getByRole("button", { expanded: false }).press("Enter");
  await workers(page).getByRole("button", { expanded: true }).waitFor();
  await page.evaluate(() => { window.overviewFixture.holdPage = 1; });
  await page.waitForFunction(() => typeof window.overviewFixture.releaseRead === "function");

  await next.press("Enter");
  await pager.getByText("Page 2 of 2", { exact: true }).waitFor();
  const secondId = pageTwo.panes[0].session.id;
  assert.deepEqual(await workers(page).evaluateAll((panes) => panes.map((pane) => pane.dataset.sessionId)), [secondId]);
  assert.equal(await workers(page).getByRole("button", { expanded: true }).count(), 0);
  assert.equal(await next.getAttribute("aria-disabled"), "true");
  assert.equal(await next.evaluate((node) => node === document.activeElement), true);
  await assertNoHorizontalOverflow(page);
  await capture(page, "overview-page-two-narrow");

  await page.evaluate(async () => {
    window.overviewFixture.releaseRead();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await workers(page).first().getAttribute("data-session-id"), secondId);
  await next.press("Space");
  assert.equal(await page.evaluate(() => window.overviewFixture.readPages.includes(3)), false);
  await previous.press("Space");
  await pager.getByText("Page 1 of 2", { exact: true }).waitFor();
  assert.equal(await previous.getAttribute("aria-disabled"), "true");
  assert.equal(await previous.evaluate((node) => node === document.activeElement), true);
  assert.equal(await workers(page).count(), 10);
  assert.equal(await workers(page).getByRole("button", { expanded: true }).count(), 0);
});
