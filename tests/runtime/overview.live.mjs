import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runtimeOutputLimit } from "@praxis/contracts";
import { createPraxisMcpServer } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";
import { chromium } from "playwright";
import { startHermesFixture, startShell, stopProcess, until } from "./hermes-fixture.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const managerPrompt = "Submit the manager fixture activity.";
const fullTool = "mcp__praxis__request_action";
const fragment = "Live output from the first Hermes worker.";

test("ten real native sessions show live output, exclusive expansion and scoped manager focus", { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-overview-live-"));
  const database = join(directory, "state.sqlite");
  const authority = join(directory, "authority.json");
  const store = new OperationalStore(database);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let shell;
  let browser;
  let mcp;
  t.after(async () => {
    release();
    await browser?.close();
    await stopProcess(shell?.processHandle);
    if (mcp !== undefined) {
      mcp.closeAllConnections();
      await new Promise((resolve) => mcp.close(resolve));
    }
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  const workers = Array.from({ length: 10 }, (_, index) => {
    const tag = String(index + 1).padStart(2, "0");
    const task = { schemaVersion: 1, id: `task_overview_${tag}`, title: `Native worker ${tag}` };
    const session = { schemaVersion: 1, id: `session_overview_${tag}`, taskId: task.id };
    store.recordTask(task);
    store.recordSession(session);
    return { task, session };
  });
  const selected = workers[0];
  const managerToken = randomBytes(32).toString("base64url");
  const operator = randomBytes(32).toString("base64url");
  const grant = {
    principalId: "principal_fixture_manager",
    tokenDigest: digest(managerToken),
    taskIds: workers.map(({ task }) => task.id),
    sessions: workers.map(({ session }) => ({ sessionId: session.id, canReport: false })),
    actionKinds: ["session.stop"],
  };
  mcp = createPraxisMcpServer({ store, grants: [grant] });
  mcp.listen(0, "127.0.0.1");
  await once(mcp, "listening");
  const mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;

  let usedStreaming = false;
  const gateway = await startHermesFixture(t, (call) => {
    const has = (text) => call.messages.some(({ role, content }) => role === "user" && JSON.stringify(content)?.includes(text));
    if (has(managerPrompt)) {
      const results = call.messages.filter(({ role }) => role === "tool");
      if (results.length > 0) {
        return { message: { role: "assistant", content: results.some(({ content }) => JSON.stringify(content)?.includes("pending"))
          ? "The real manager submitted its scoped MCP request."
          : `Manager fixture tool result: ${JSON.stringify(results.at(-1).content).slice(0, 500)}` } };
      }
      const direct = call.tools?.some(({ function: tool }) => tool?.name === fullTool);
      const args = {
        submissionId: "event_overview_manager", occurredAt: "2026-07-28T10:30:00Z", kind: "session.stop",
        target: { kind: "session", id: selected.session.id },
      };
      return {
        finishReason: "tool_calls",
        message: {
          role: "assistant", content: null,
          tool_calls: [{
            id: "call_overview_manager_fixture", type: "function",
            function: {
              name: direct ? fullTool : "tool_call",
              arguments: JSON.stringify(direct ? args : { calls: [{ name: fullTool, arguments: args }] }),
            },
          }],
        },
      };
    }
    if (has(selected.task.title)) {
      usedStreaming ||= Boolean(call.stream);
      return { message: { role: "assistant", content: fragment }, holdAfterMessage: held };
    }
    if (has(workers[1].task.title)) {
      const lines = Array.from({ length: 500 }, (_, index) => `Native fixture output line ${index} with its own sequence.\n`);
      return { message: { role: "assistant", content: lines.join("") + "native long output tail" } };
    }
    return { message: { role: "assistant", content: "Native worker output from the isolated provider." } };
  }, [
    "mcp_servers:",
    "  praxis:",
    `    url: "${mcpUrl}"`,
    "    headers:",
    `      Authorization: "Bearer ${managerToken}"`,
    "    trust: full",
  ]);

  const assignments = [];
  for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) {
    const worker = workers[index];
    const assignment = await gateway.runtime.createAssignment(worker.session, worker.task.title);
    assignments[index] = assignment;
    const expected = index === 0 ? "running" : "completed";
    await until(async () => {
      const { status } = await gateway.runtime.inspectAssignment(assignment);
      assert.ok(!["failed", "interrupted", "unknown", "stopped"].includes(status),
        `Native worker ${index + 1} returned ${status}`);
      return status === expected;
    }, `The isolated native worker ${index + 1} did not reach ${expected}`);
  }
  await writeFile(authority, JSON.stringify({
    schemaVersion: 1, database, grants: [{
      ...grant, sessions: grant.sessions.map((entry, index) => ({ ...entry, assignment: assignments[index] })),
    }],
  }), { mode: 0o600 });

  shell = await startShell(directory, {
    PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator),
    PRAXIS_MCP_CONFIG_FILE: authority,
    PRAXIS_HERMES_ORIGIN: gateway.origin,
    PRAXIS_HERMES_API_KEY: gateway.apiKey,
    PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID: grant.principalId,
  });
  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(12_000);
  await page.goto(shell.origin);
  await page.getByRole("heading", { name: "Manager", exact: true }).waitFor();
  const command = (onPage, value) => onPage.getByRole("textbox", { name: "Command", exact: true })
    .fill(value).then(() => onPage.getByRole("textbox", { name: "Command", exact: true }).press("Enter"));
  await command(page, "/overview");
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  const overview = page.locator('[data-view="overview"]');
  assert.equal(await overview.evaluate((view) => getComputedStyle(view).animationName), "overview-enter");

  async function openOverview(onPage = page) {
    const form = onPage.getByRole("form", { name: "Open Overview" });
    await form.getByLabel("Operator token").fill(operator);
    await form.getByRole("button", { name: "Open overview" }).click();
    await onPage.waitForFunction(() => document.querySelectorAll("#overview-grid .session-pane").length === 10);
  }
  await openOverview();
  const bySession = (id) => page.locator(`.session-pane[data-session-id="${id}"]`);
  const primary = bySession(selected.session.id);
  const secondary = bySession(workers[1].session.id);
  await primary.getByText(fragment).waitFor();
  assert.equal(usedStreaming, true);
  assert.equal((await gateway.runtime.inspectAssignment(assignments[0])).status, "running");
  await secondary.getByText(/native long output tail/).waitFor();
  assert.ok((await secondary.getByLabel("Session output").textContent()).length <= runtimeOutputLimit + 24);
  assert.equal(await page.evaluate(() => document.querySelector("#overview-grid").getBoundingClientRect().bottom
    <= document.querySelector("#command-bar").getBoundingClientRect().top), true);

  await primary.getByRole("button", { name: "Expand" }).click();
  assert.equal(await primary.getByRole("button", { name: "Collapse" }).getAttribute("aria-expanded"), "true");
  await secondary.getByRole("button", { name: "Expand" }).click();
  assert.equal(await page.locator('.session-pane[data-expanded="true"]').count(), 1);
  await secondary.getByText(/Input tokens|Output tokens/).waitFor();

  await page.reload();
  await openOverview();
  await primary.getByText(fragment).waitFor();
  assert.equal((await primary.getByLabel("Session output").textContent()).split(fragment).length, 2);

  const manager = await gateway.runtime.createAssignment({
    schemaVersion: 1, id: "session_isolated_manager", taskId: "task_isolated_manager",
  }, managerPrompt);
  const completedManager = await until(async () => {
    const snapshot = await gateway.runtime.inspectAssignment(manager);
    assert.ok(!["failed", "interrupted", "unknown", "stopped"].includes(snapshot.status),
      `The native manager returned ${snapshot.status}`);
    return snapshot.status === "completed" ? snapshot : false;
  }, "The manager run did not settle");
  assert.match(completedManager.output.text, /real manager submitted/);
  const request = store.eventsOfKind("action.requested").find(({ details }) =>
    details?.type === "action_request" && details.actorId === grant.principalId);
  assert.equal(request?.subject.id, selected.session.id);
  await page.locator(`.session-pane[data-session-id="${selected.session.id}"][data-highlighted="true"]`).waitFor();
  assert.equal(await page.locator('.session-pane[data-highlighted="true"]').count(), 1);

  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("complementary", { name: "Activity" });
  await activity.getByLabel("Operator token").fill(operator);
  await activity.getByRole("button", { name: "Unlock activity" }).click();
  const card = activity.locator(`[data-request-id="${request.id}"]`);
  await card.getByRole("button", { name: "Inspect", exact: true }).click();
  await card.getByRole("button", { name: "Deny", exact: true }).click();
  await card.getByText("Denied", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.session-pane[data-highlighted="true"]').length === 0);
  assert.equal((await gateway.runtime.inspectAssignment(assignments[0])).status, "running");
  release();
  await until(async () => (await gateway.runtime.inspectAssignment(assignments[0])).status === "completed",
    "The selected native worker did not continue after denial");

  const reduced = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 360, height: 620 } });
  await reduced.goto(shell.origin);
  await command(reduced, "/o");
  assert.equal(await reduced.locator('[data-view="overview"]').evaluate((view) => getComputedStyle(view).animationName), "none");
  await openOverview(reduced);
  assert.equal(await reduced.locator(".session-pane").first().evaluate((pane) => getComputedStyle(pane).transitionDuration), "0s");
  t.diagnostic("Ten real sessions, native live/replayed and bounded output, measured usage, exclusive expansion, manager focus and reduced motion passed.");
});
