import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPraxisMcpServer } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";
import { enter, eventually, startDesktop } from "./desktop-fixture.mjs";
import { startHermesFixture, until } from "./hermes-fixture.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const guidance = "Check the fixture notes before summarizing.";
const manualTitle = "Review the desktop session control fixture.";
const denyTitle = "Keep the denied desktop worker running.";

function worker(label, title) {
  const task = { schemaVersion: 1, id: `task_desktop_${label}`, title };
  return { task, session: { schemaVersion: 1, taskId: task.id, id: `session_desktop_${label}` } };
}

function todoResponse(call, stage) {
  const direct = call.tools?.some(({ function: tool }) => tool.name === "todo_list");
  return { finishReason: "tool_calls", message: {
    role: "assistant", content: null,
    tool_calls: [{
      id: `call_desktop_boundary_${stage}`, type: "function",
      function: {
        name: direct ? "todo_list" : "tool_call",
        arguments: JSON.stringify(direct ? {} : { calls: [{ name: "todo_list", arguments: {} }] }),
      },
    }],
  } };
}

test("the packaged operator denies, fences and approves exact real Hermes worker actions", { timeout: 150_000 }, async (t) => {
  const packagePath = process.env.PRAXIS_DESKTOP_DEB;
  assert.ok(packagePath && isAbsolute(packagePath), "Set PRAXIS_DESKTOP_DEB to the packaged desktop artifact.");
  const directory = await mkdtemp(join(tmpdir(), "praxis-desktop-control-"));
  const database = join(directory, "state.sqlite");
  const store = new OperationalStore(database);
  const holds = Array.from({ length: 3 }, () => Promise.withResolvers());
  const deniedHold = Promise.withResolvers();
  let desktop;
  let mcp;
  let client;
  t.after(async () => {
    for (const hold of holds) hold.resolve();
    deniedHold.resolve();
    await desktop?.close();
    await client?.close();
    if (mcp?.listening) {
      mcp.closeAllConnections();
      await new Promise((resolve) => mcp.close(resolve));
    }
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  });

  const installed = join(directory, "installed");
  execFileSync("dpkg-deb", ["--extract", packagePath, installed]);
  const binary = join(installed, "usr/bin/praxis-desktop");
  const manual = worker("manual", manualTitle);
  const denied = worker("denied", denyTitle);
  for (const { task, session } of [manual, denied]) {
    store.recordTask(task);
    store.recordSession(session);
  }

  let providerStage = -1;
  let guidanceDelivered = false;
  const gateway = await startHermesFixture(t, async (call) => {
    const has = (text) => call.messages.some(({ role, content }) => role === "user" && JSON.stringify(content)?.includes(text));
    const main = call.tools?.some(({ function: tool }) => tool.name === "todo_list" || tool.name === "tool_call");
    if (main && has(denyTitle)) await deniedHold.promise;
    if (main && has(manualTitle)) {
      const stage = call.messages.filter(({ role }) => role === "tool").length;
      providerStage = Math.max(providerStage, stage);
      if (stage > 0 && has(guidance)) guidanceDelivered = true;
      await holds[Math.min(stage, 2)].promise;
      if (stage < 2) return todoResponse(call, stage);
    }
    return { message: { role: "assistant", content: "The desktop fixture run finished." } };
  });
  const { runtime } = gateway;
  manual.assignment = await runtime.createAssignment(manual.session, manual.task.title);
  await until(() => providerStage === 0, "The manual worker did not reach its first provider boundary.");
  denied.assignment = await runtime.createAssignment(denied.session, denied.task.title);
  await until(async () => (await runtime.inspectAssignment(denied.assignment)).status === "running", "The second worker did not start.");

  const operator = randomBytes(32).toString("base64url");
  const workerToken = randomBytes(32).toString("base64url");
  const authority = join(directory, "authority.json");
  const grant = {
    principalId: "principal_desktop_control", tokenDigest: digest(workerToken),
    taskIds: [manual.task.id, denied.task.id],
    sessions: [manual, denied].map(({ session, assignment }) => ({
      sessionId: session.id, assignment, canReport: false, operatorCanTakeover: session.id === manual.session.id,
    })),
    actionKinds: ["session.stop"],
  };
  await writeFile(authority, JSON.stringify({ schemaVersion: 1, database, grants: [grant] }), { mode: 0o600 });
  mcp = createPraxisMcpServer({ store, grants: [grant] }).listen(0, "127.0.0.1");
  await once(mcp, "listening");
  client = new Client({ name: "praxis-desktop-control-fixture", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.address().port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${workerToken}` } },
  }));
  for (const session of [manual, denied]) {
    const receipt = (await client.callTool({ name: "request_action", arguments: {
      submissionId: `event_stop_${session.session.id}`, occurredAt: new Date().toISOString(),
      kind: "session.stop", target: { kind: "session", id: session.session.id },
    } })).structuredContent;
    assert.equal(receipt.status, "pending");
    session.requestId = receipt.event.id;
  }
  const environment = {
    PRAXIS_CONFIG_FILE: join(directory, "settings.json"), PRAXIS_MCP_CONFIG_FILE: authority,
    PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator), PRAXIS_HERMES_ORIGIN: gateway.origin,
    PRAXIS_HERMES_API_KEY: gateway.apiKey, PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID: grant.principalId,
    XDG_DATA_HOME: join(directory, "data"), XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
  };
  const evidence = process.env.PRAXIS_DESKTOP_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const selectors = {
    toggle: "#activity-toggle", panel: "praxis-activity-panel aside",
    manual: `article[data-session-id="${manual.session.id}"]`,
    approved: `article[data-request-id="${manual.requestId}"]`,
    denied: `article[data-request-id="${denied.requestId}"]`,
  };
  const click = async (selector) => (await desktop.element(selector)).click();
  const containing = (selector, text) => desktop.execute(
    "return document.querySelector(arguments[0])?.textContent.includes(arguments[1])",
    selector, text,
  );
  const shows = (selector, text) => eventually(() => containing(selector, text), `Expected operator feedback: ${text}`);
  const unlock = async (form, token) => {
    await (await desktop.element(`form[aria-label="${form}"] input[type="password"]`)).type(token);
    await click(`form[aria-label="${form}"] button[type="submit"]`);
  };
  const launch = async () => {
    desktop = await startDesktop(binary, { environment });
    assert.equal((await desktop.handles()).length, 1);
    await desktop.waitForText("praxis-host-launch [role=status]", "Local Praxis host ready.");
  };
  const overview = async () => {
    const command = await desktop.element('input[aria-label="Command"]');
    await command.click();
    await command.type("/o" + enter);
    await desktop.waitForText("h1", "Overview");
    await unlock("Open Overview", operator);
    await click(`${selectors.manual} button[aria-expanded]`);
  };

  await launch();
  assert.equal(await desktop.execute("return !!document.querySelector('#activity-toggle')"), true,
    "The packaged desktop exposes the scoped Activity panel.");
  await click(selectors.toggle);
  await unlock("Unlock activity", workerToken);
  await shows(selectors.panel, "An operator credential is required.");
  await unlock("Unlock activity", operator);
  await click(`${selectors.denied} [data-action="inspect"]`);
  await click(`${selectors.denied} [data-action="deny"]`);
  await shows(selectors.denied, "Denied");
  assert.equal((await runtime.inspectAssignment(denied.assignment)).status, "running");
  await click(selectors.toggle);

  await overview();
  await shows(selectors.manual, "Read-only inspection");
  await click(`${selectors.manual} [data-operation="takeover"]`);
  await shows(selectors.manual, "Manual control");
  await click(selectors.toggle);
  await click(`${selectors.approved} [data-action="inspect"]`);
  await click(`${selectors.approved} [data-action="approve"]`);
  await shows(selectors.panel, "Session control holds this action.");
  assert.equal(store.eventsOfKind("action.decision").length, 1);
  await click(selectors.toggle);

  await (await desktop.element(`${selectors.manual} textarea`)).type(guidance);
  await click(`${selectors.manual} [data-operation="guide"]`);
  await shows(selectors.manual, "Hermes accepted this guidance for delivery.");
  holds[0].resolve();
  await until(() => providerStage === 1 && guidanceDelivered, "The independent worker did not receive the guidance.");
  await click(`${selectors.manual} [data-operation="return"]`);
  await shows(selectors.manual, "Manual control remains active.");
  assert.equal(store.sessionControl(manual.session.id).mode, "manual");
  if (evidence) await desktop.screenshot(join(evidence, "manual-fence-before-restart.png"));

  await desktop.close();
  desktop = undefined;
  await launch();
  await overview();
  await shows(selectors.manual, "Waiting for Hermes to record guidance.");
  assert.equal((await runtime.inspectAssignment(manual.assignment)).status, "running");
  holds[1].resolve();
  await until(() => providerStage === 2, "The native worker did not reach its second boundary.");
  const pending = store.sessionControl(manual.session.id).pending;
  await until(async () => await runtime.reconcileGuidance(manual.assignment, pending.afterMessageId, pending.textDigest)
    === "delivered", "The exact guide receipt did not become durable.");
  await click(`${selectors.manual} [data-operation="return"]`);
  await shows(selectors.manual, "Control returned. Hermes delivered the guidance at a tool boundary.");
  assert.equal(store.sessionControl(manual.session.id), undefined);

  await click(selectors.toggle);
  await unlock("Unlock activity", operator);
  await shows(selectors.denied, "Denied");
  await click(`${selectors.approved} [data-action="approve"]`);
  await shows(selectors.approved, "Stop requested. Hermes has yet to report a settled stop.");
  if (evidence) await desktop.screenshot(join(evidence, "activity-deny-and-approve.png"));
  holds[2].resolve();
  await until(async () => (await runtime.inspectAssignment(manual.assignment)).status === "stopped", "The approved exact worker did not stop.");
  assert.equal((await runtime.inspectAssignment(denied.assignment)).status, "running");
  assert.equal(store.eventsOfKind("action.decision").length, 2);
  deniedHold.resolve();
  await until(async () => (await runtime.inspectAssignment(denied.assignment)).status === "completed", "The denied worker did not complete normally.");
  t.diagnostic("Native operator authorization, scoped deny and approve, manual fencing across restart, and verified guidance handback passed.");
});
