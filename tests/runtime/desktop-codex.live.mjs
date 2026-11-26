import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { createPraxisMcpServer } from "@praxis/mcp";
import { defaultSettings } from "@praxis/settings";
import { OperationalStore } from "@praxis/state";
import { enter, eventually, startDesktop } from "./desktop-fixture.mjs";
import { startNamedHermesFixture } from "./named-hermes-fixture.mjs";

const task = { schemaVersion: 1, id: "task_packaged_codex", title: "Change the disposable fixture" };
const session = { schemaVersion: 1, id: "session_packaged_codex", taskId: task.id };
const profile = "praxis-codex-fixture-manager";
const prompt = "Request the scoped fixture assignment.";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const reply = (content) => ({ message: { role: "assistant", content } });
const toolName = "mcp__praxis__request_action";
const credential = () => randomBytes(32).toString("base64url");

function toolReply(body, args) {
  const direct = body.tools?.some(({ function: fn }) => fn?.name === toolName);
  return { finishReason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
    id: "call_packaged_delegation", type: "function", function: {
      name: direct ? toolName : "tool_call",
      arguments: JSON.stringify(direct ? args : { calls: [{ name: toolName, arguments: args }] }),
    },
  }] } };
}

test("packaged Manager reaches the operator review for a native Codex assignment", { timeout: 120_000 }, async (t) => {
  const packagePath = process.env.PRAXIS_DESKTOP_DEB;
  assert.ok(packagePath && isAbsolute(packagePath), "Set PRAXIS_DESKTOP_DEB to the packaged development artifact.");
  const directory = await mkdtemp(join(tmpdir(), "praxis-desktop-codex-"));
  const database = join(directory, "state.sqlite");
  const store = new OperationalStore(database);
  let desktop;
  let mcp;
  t.after(async () => {
    await desktop?.close();
    if (mcp?.listening) {
      mcp.closeAllConnections();
      await new Promise((resolve) => mcp.close(resolve));
    }
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const installed = join(directory, "installed");
  execFileSync("dpkg-deb", ["--extract", packagePath, installed]);

  store.recordTask(task);
  store.recordSession(session);
  const mcpToken = credential();
  const operator = credential();
  const grant = {
    principalId: "principal_packaged_manager", tokenDigest: digest(mcpToken),
    taskIds: [task.id], sessions: [{ sessionId: session.id, canReport: false }], actionKinds: ["task.delegate"],
  };
  mcp = createPraxisMcpServer({ store, grants: [grant] }).listen(0, "127.0.0.1");
  await once(mcp, "listening");
  const mcpOrigin = "http://127.0.0.1:" + mcp.address().port + "/mcp";
  const occurredAt = new Date().toISOString();
  const gateway = await startNamedHermesFixture(t, profile, (body) => {
    if (!body.tools?.length) return reply("Fixture auxiliary response.");
    const index = body.messages.findLastIndex(({ role }) => role === "user");
    if (body.messages[index]?.content !== prompt) return reply("Fixture manager response.");
    const tool = body.messages.slice(index + 1).findLast(({ role }) => role === "tool");
    if (tool) return reply(JSON.stringify(tool.content).includes("pending")
      ? "The delegation request is pending review." : "The delegation request failed.");
    return toolReply(body, {
      submissionId: "event_packaged_codex_delegation", occurredAt,
      kind: "task.delegate", target: { kind: "task", id: task.id },
    });
  }, { mcpOrigin, mcpToken });

  const authority = join(directory, "authority.json");
  const settings = join(directory, "settings.json");
  await writeFile(authority, JSON.stringify({ schemaVersion: 1, database, grants: [grant] }), { mode: 0o600 });
  const defaults = defaultSettings();
  await writeFile(settings, JSON.stringify({ ...defaults, manager: { ...defaults.manager, profile } }), { mode: 0o600 });
  desktop = await startDesktop(join(installed, "usr/bin/praxis-desktop"), { environment: {
    PRAXIS_CONFIG_FILE: settings, PRAXIS_MCP_CONFIG_FILE: authority,
    PRAXIS_HERMES_ORIGIN: gateway.origin, PRAXIS_HERMES_API_KEY: gateway.apiKey,
    PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator), PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID: grant.principalId,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), XDG_CACHE_HOME: join(directory, "cache"),
  } });
  await desktop.waitForText("praxis-host-launch [role=status]", "Local Praxis host ready.");
  const click = async (selector) => (await desktop.element(selector)).click();
  const unlock = async (form) => {
    const selector = 'form[aria-label="' + form + '"]';
    await (await desktop.element(selector + " input[type=password]")).type(operator);
    await click(selector + " button[type=submit]");
  };
  await desktop.waitForText("h1", "Manager");
  await unlock("Open Manager");
  await desktop.waitForText("#manager-lock", "Lock manager");
  const command = await desktop.element('[aria-label="Command"]');
  await command.click();
  await command.type(prompt + enter);
  const matching = () => store.eventsOfKind("action.requested").find(({ details }) =>
    details?.type === "action_request" && details.action.kind === "task.delegate" && details.action.target.id === task.id);
  const intent = await eventually(matching, "Named Hermes did not write its scoped delegation intent.");
  assert.equal(intent.details.actorId, grant.principalId);

  await click("#activity-toggle");
  await unlock("Unlock activity");
  const card = 'article[data-request-id="' + intent.id + '"]';
  await click(card + ' [data-action="inspect"]');
  const evaluated = await eventually(() => store.eventsOfKind("action.evaluation").find(({ details }) =>
    details.requestId === intent.id), "The packaged Activity did not evaluate the exact request.");
  assert.equal(evaluated.details.transition.value.mode, "approval",
    "The packaged Activity must open an exact Codex delegation approval for the native Manager request.");
});
