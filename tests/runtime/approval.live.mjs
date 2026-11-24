import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPraxisMcpServer } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";
import { chromium } from "playwright";
import { startHermesFixture, startShell, stopProcess, until } from "./hermes-fixture.mjs";

const digest = (token) => createHash("sha256").update(token).digest("hex");

function pinnedRun(name) {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const task = { schemaVersion: 1, id: `task_${name}`, title: `${name} fixture` };
  return { task, session: { schemaVersion: 1, id: `session_${name}`, taskId: task.id }, hold, release };
}

test("the Praxis browser authorizes one real Hermes stop and denial preserves another run", { timeout: 120_000 }, async (t) => {
  const approve = pinnedRun("approved");
  const deny = pinnedRun("denied");
  const runs = [approve, deny];
  t.after(() => { for (const run of runs) run.release(); });
  const gateway = await startHermesFixture(t, async (call) => {
    const current = runs.find(({ task }) => call.messages.some(({ content }) => JSON.stringify(content)?.includes(task.title)));
    if (current !== undefined) await current.hold;
    return { message: { role: "assistant", content: "The approval fixture completed." } };
  });

  for (const run of runs) {
    run.assignment = await gateway.runtime.createAssignment(run.session, run.task.title);
    await until(async () => (await gateway.runtime.inspectAssignment(run.assignment)).status === "running",
      `Hermes did not start ${run.task.id}`);
  }

  const worker = randomBytes(32).toString("base64url");
  const operator = randomBytes(32).toString("base64url");
  const authority = join(gateway.directory, "authority.json");
  const database = join(gateway.directory, "state.sqlite");
  const store = new OperationalStore(database);
  for (const run of runs) {
    store.recordTask(run.task);
    store.recordSession(run.session);
  }
  const grants = [{
    principalId: "principal_worker",
    tokenDigest: digest(worker),
    taskIds: runs.map(({ task }) => task.id),
    sessions: runs.map(({ session, assignment }) => ({ sessionId: session.id, canReport: true, assignment })),
    actionKinds: ["session.stop", "session.inspect"],
  }];
  await writeFile(authority, JSON.stringify({ schemaVersion: 1, database, grants }), { mode: 0o600 });

  const mcp = createPraxisMcpServer({ store, grants });
  mcp.listen(0, "127.0.0.1");
  await once(mcp, "listening");
  const client = new Client({ name: "praxis-approval-fixture", version: "1.0" });
  t.after(async () => {
    await client.close();
    mcp.closeAllConnections();
    await new Promise((resolve) => mcp.close(resolve));
    store.close();
  });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${mcp.address().port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${worker}` } } },
  ));
  const submit = (name, kind, sessionId) => client.callTool({
    name: "request_action",
    arguments: {
      submissionId: `event_fixture_${name}`,
      occurredAt: "2000-01-01T00:00:00Z",
      kind,
      target: { kind: "session", id: sessionId },
    },
  });
  for (const run of runs) {
    const receipt = (await submit(run.task.id, "session.stop", run.session.id)).structuredContent;
    assert.equal(receipt.status, "pending");
    run.requestId = receipt.event.id;
  }
  const routine = (await submit("routine", "session.inspect", deny.session.id)).structuredContent;
  assert.equal(routine.status, "pending");

  const shell = await startShell(gateway.directory, {
    PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator),
    PRAXIS_MCP_CONFIG_FILE: authority,
    PRAXIS_HERMES_ORIGIN: gateway.origin,
    PRAXIS_HERMES_API_KEY: gateway.apiKey,
  });
  t.after(() => stopProcess(shell.processHandle));
  await until(() => store.eventsOfKind("action.settlement").some(({ details }) =>
    details?.type === "action_lifecycle" && details.requestId === routine.event.id
    && details.transition.value.outcome === "resolved"),
  "The routine request did not resolve before opening the operator UI");
  const browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 980, height: 760 } });
  page.setDefaultTimeout(6_000);
  await page.goto(shell.origin);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const token = page.getByLabel("Operator token");
  const unlock = page.getByRole("button", { name: "Unlock activity" });
  await token.fill(worker);
  await unlock.click();
  await page.getByRole("status").getByText("An operator credential is required.").waitFor();
  await token.fill(operator);
  await unlock.click();

  const card = (requestId) => page.locator(`article[data-request-id="${requestId}"]`);
  const approved = card(approve.requestId);
  await approved.getByText("Processing", { exact: true }).waitFor();
  const original = await approved.elementHandle();
  await approved.getByRole("button", { name: "Inspect" }).click();
  await approved.getByText("Needs attention", { exact: true }).waitFor();
  const command = page.getByRole("textbox", { name: "Command", exact: true });
  await command.fill("/overview");
  await command.press("Enter");
  await page.getByRole("heading", { name: "Overview" }).waitFor();
  await approved.getByRole("button", { name: "Approve once" }).waitFor();
  assert.equal(await original.evaluate((element) => document.querySelector(`[data-request-id="${element.dataset.requestId}"]`) === element), true);

  const api = new URL("api/activity", shell.origin);
  const activity = await fetch(api, { headers: { Authorization: `Bearer ${operator}` } }).then((response) => response.json());
  const approvalId = activity.find(({ requestId }) => requestId === approve.requestId).approval.id;
  const actionDecision = { requestId: approve.requestId, approvalId, decision: "approve" };
  const post = (credential, source) => fetch(new URL("api/activity/decision", shell.origin), {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, Origin: source, "Content-Type": "application/json" },
    body: JSON.stringify(actionDecision),
  });
  const origin = new URL(shell.origin).origin;
  assert.equal((await post(worker, origin)).status, 401);
  assert.equal((await post(operator, "http://localhost:3215")).status, 403);
  assert.equal((await gateway.runtime.inspectAssignment(approve.assignment)).status, "running");

  await approved.getByRole("button", { name: "Approve once" }).click();
  await approved.getByText("Stop requested. Hermes has yet to report a settled stop.").waitFor();
  assert.equal((await post(operator, origin)).status, 409);
  approve.release();
  await until(async () => (await gateway.runtime.inspectAssignment(approve.assignment)).status === "stopped",
    "The approved native run did not stop");

  const routineCard = card(routine.event.id);
  await routineCard.getByText("Hermes reported the run as running.").waitFor();
  assert.equal(await routineCard.getByRole("button", { name: "Approve once" }).count(), 0);

  const denied = card(deny.requestId);
  await denied.getByRole("button", { name: "Inspect" }).click();
  await denied.getByRole("button", { name: "Deny" }).click();
  await denied.getByText("Denied", { exact: true }).waitFor();
  assert.equal((await gateway.runtime.inspectAssignment(deny.assignment)).status, "running");
  deny.release();
  await until(async () => (await gateway.runtime.inspectAssignment(deny.assignment)).status === "completed",
    "The denied native run did not continue to completion");
  t.diagnostic("Real MCP request, processing-to-attention card, scoped operator decision, replay denial, native stop and preserved denied run passed.");
});
