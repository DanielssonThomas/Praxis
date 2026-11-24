import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPraxisMcpServer } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";
import { chromium } from "playwright";
import { startHermesFixture, startShell, stopProcess, until } from "./hermes-fixture.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");
const task = { schemaVersion: 1, id: "task_manual_fixture", title: "Review the local session control fixture." };
const session = { schemaVersion: 1, id: "session_manual_fixture", taskId: task.id };
const managerPrompt = "Submit the scoped stop request for the control fixture.";
const guidance = "Check the fixture notes before summarizing.";

const hasTool = (call, name) => call.tools?.some(({ function: candidate }) => candidate?.name === name);

function toolResponse(call, id, name, args = {}) {
  const direct = hasTool(call, name);
  return {
    finishReason: "tool_calls",
    message: {
      role: "assistant", content: null,
      tool_calls: [{
        id, type: "function",
        function: {
          name: direct ? name : "tool_call",
          arguments: JSON.stringify(direct ? args : { calls: [{ name, arguments: args }] }),
        },
      }],
    },
  };
}

test("the browser fences a real manager action and reconciles manual guidance before active native handback", { timeout: 150_000 }, async (t) => {
  const token = randomBytes(32).toString("base64url");
  const operator = randomBytes(32).toString("base64url");
  const grant = {
    principalId: "principal_fixture_manager", tokenDigest: digest(token), taskIds: [task.id],
    sessions: [{ sessionId: session.id, canReport: false }], actionKinds: ["session.stop"],
  };
  const holds = Array.from({ length: 3 }, () => Promise.withResolvers());
  t.after(() => { for (const hold of holds) hold.resolve(); });
  let stage = -1;
  let deliveredToModel = false;
  let shell;
  let browser;

  const directory = await mkdtemp(join(tmpdir(), "praxis-control-live-"));
  const database = join(directory, "control.sqlite");
  const authority = join(directory, "authority.json");
  const store = new OperationalStore(database);
  store.recordTask(task);
  store.recordSession(session);
  const mcp = createPraxisMcpServer({ store, grants: [grant] });
  mcp.listen(0, "127.0.0.1");
  await once(mcp, "listening");
  t.after(async () => {
    await browser?.close();
    await stopProcess(shell?.processHandle);
    mcp.closeAllConnections();
    await new Promise((resolve) => mcp.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const gateway = await startHermesFixture(t, async (call) => {
    const has = (text) => call.messages.some(({ role, content }) => role === "user" && JSON.stringify(content)?.includes(text));
    const tools = call.messages.filter(({ role }) => role === "tool").length;
    if (has(managerPrompt) && (hasTool(call, "mcp__praxis__request_action") || hasTool(call, "tool_call"))) {
      if (tools === 0) return toolResponse(call, "call_manager_stop", "mcp__praxis__request_action", {
        submissionId: "event_control_manager_stop", occurredAt: "2026-09-20T10:00:00Z", kind: "session.stop",
        target: { kind: "session", id: session.id },
      });
      const accepted = call.messages.some(({ role, content }) => role === "tool" && JSON.stringify(content)?.includes("pending"));
      return { message: { role: "assistant", content: accepted ? "Scoped request submitted." : "Scoped request was not submitted." } };
    }
    if (has(task.title) && (hasTool(call, "todo_list") || hasTool(call, "tool_call"))) {
      stage = Math.max(stage, tools);
      if (tools > 0 && has(guidance)) deliveredToModel = true;
      await holds[Math.min(tools, 2)].promise;
      if (tools < 2) return toolResponse(call, `call_control_boundary_${tools}`, "todo_list");
    }
    return { message: { role: "assistant", content: "The local session-control fixture finished." } };
  }, [
    "mcp_servers:", "  praxis:", `    url: "http://127.0.0.1:${mcp.address().port}/mcp"`,
    "    headers:", `      Authorization: "Bearer ${token}"`, "    trust: full",
  ]);

  const assignment = await gateway.runtime.createAssignment(session, task.title);
  await until(() => stage === 0, "The exact native worker did not reach the first provider boundary");
  await writeFile(authority, JSON.stringify({
    schemaVersion: 1, database, grants: [{
      ...grant, sessions: [{ ...grant.sessions[0], assignment, operatorCanTakeover: true }],
    }],
  }), { mode: 0o600 });

  const manager = await gateway.runtime.createAssignment({
    schemaVersion: 1, id: "session_control_manager", taskId: "task_control_manager",
  }, managerPrompt);
  const managerDone = await until(async () => {
    const snapshot = await gateway.runtime.inspectAssignment(manager);
    return snapshot.status === "completed" ? snapshot : false;
  }, "The real fixture manager did not finish");
  assert.match(managerDone.output.text, /Scoped request submitted/);
  const [request] = store.eventsOfKind("action.requested");
  assert.equal(request.details.actorId, grant.principalId);
  assert.equal(request.subject.id, session.id);

  const environment = {
    PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator),
    PRAXIS_MCP_CONFIG_FILE: authority,
    PRAXIS_HERMES_ORIGIN: gateway.origin,
    PRAXIS_HERMES_API_KEY: gateway.apiKey,
    PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID: grant.principalId,
  };
  shell = await startShell(directory, environment);
  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(10_000);
  const pane = page.locator(`article[data-session-id="${session.id}"]`);
  const card = page.locator(`article[data-request-id="${request.id}"]`);
  async function overview() {
    await page.goto(new URL("#overview", shell.origin).href);
    const form = page.getByRole("form", { name: "Open Overview" });
    await form.getByLabel("Operator token").fill(operator);
    await form.getByRole("button", { name: "Open overview" }).click();
    await pane.getByRole("button", { name: "Expand" }).click();
  }
  async function activity() {
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    const form = page.getByRole("form", { name: "Unlock activity" });
    await form.getByLabel("Operator token").fill(operator);
    await form.getByRole("button", { name: "Unlock activity" }).click();
  }
  const dispatch = (guardToken, origin, body) => fetch(new URL("/api/overview/control", shell.origin), {
    method: "POST",
    headers: { Authorization: `Bearer ${guardToken}`, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: session.id, ...body }),
  });
  const local = new URL(shell.origin).origin;
  await overview();
  await pane.getByText("Read-only inspection", { exact: true }).waitFor();
  assert.equal(await pane.getByLabel("Manual guidance").isVisible(), false);
  assert.equal((await dispatch(token, local, { operation: "takeover" })).status, 401);
  assert.equal((await dispatch(operator, "http://localhost:3213", { operation: "takeover" })).status, 403);
  assert.equal((await dispatch(operator, local, { operation: "guide", text: guidance })).status, 409);

  await pane.getByRole("button", { name: "Take over" }).click();
  await pane.getByText("Manual control", { exact: true }).waitFor();
  await activity();
  await card.getByRole("button", { name: "Inspect" }).click();
  await card.getByRole("button", { name: "Approve once" }).click();
  await page.getByText("Session control holds this action.", { exact: false }).waitFor();
  assert.equal(store.eventsOfKind("action.decision").length, 0);
  assert.equal((await gateway.runtime.inspectAssignment(assignment)).status, "running");
  await page.getByRole("button", { name: "Activity", exact: true }).click();

  await pane.getByLabel("Manual guidance").fill(guidance);
  await pane.getByRole("button", { name: "Send guidance" }).click();
  await pane.getByText("Hermes accepted this guidance for delivery.", { exact: true }).waitFor();
  holds[0].resolve();
  await until(() => stage === 1 && deliveredToModel, "Hermes did not carry the guidance to its next provider request");
  await pane.getByRole("button", { name: "Return control" }).click();
  await pane.getByText("Manual control remains active.", { exact: false }).waitFor();
  assert.equal(store.sessionControl(session.id).mode, "manual");

  await stopProcess(shell.processHandle);
  shell = await startShell(directory, environment);
  await overview();
  await pane.getByText("Manual control. Waiting for Hermes to record guidance.", { exact: true }).waitFor();
  holds[1].resolve();
  await until(() => stage === 2, "Hermes did not reach its second tool boundary");
  const pending = store.sessionControl(session.id).pending;
  await until(async () => await gateway.runtime.reconcileGuidance(assignment, pending.afterMessageId, pending.textDigest)
    === "delivered", "The exact native guidance receipt did not become durable during the run");
  assert.equal((await gateway.runtime.inspectAssignment(assignment)).status, "running");
  await pane.getByRole("button", { name: "Return control" }).click();
  await pane.getByText("Control returned. Hermes delivered the guidance at a tool boundary.", { exact: true }).waitFor();
  assert.equal(store.sessionControl(session.id), undefined);
  await activity();
  await card.getByRole("button", { name: "Approve once" }).click();
  await card.getByText("Stop requested. Hermes has yet to report a settled stop.", { exact: true }).waitFor();
  holds[2].resolve();
  await until(async () => (await gateway.runtime.inspectAssignment(assignment)).status === "stopped",
    "The ordinary scoped action did not stop the exact native worker after return");
  assert.equal(store.eventsOfKind("action.decision").length, 1);
  t.diagnostic("Native manager request and offline handback, durable manual fence on host restart, live guidance reconciliation, and scoped stop after return passed.");
});
