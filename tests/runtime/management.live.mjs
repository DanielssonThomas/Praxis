import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { ManagementService } from "@praxis/management";
import { createPraxisMcpServer } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";
import { providerFixture, stopProcess, until } from "./hermes-fixture.mjs";

const execute = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const key = () => randomBytes(32).toString("base64url");
const task = { schemaVersion: 1, id: "task_management_fixture", title: "Background coordination fixture" };
const buildSession = (id) => ({ schemaVersion: 1, id: "session_" + id, taskId: task.id });
const fore = buildSession("management_foreground");
const workers = [
  { session: buildSession("management_question"), phase: "question", prompt: "Management worker fixture question.", text: "Resolve the fixture question." },
  { session: buildSession("management_result"), phase: "result", prompt: "Management worker fixture result.", text: "Review the fixture result." },
];
const direction = "Prioritize the operator's fixture direction.";
const maintenance = "Review deferred maintenance.";
const profile = "praxis-background-fixture";

function toolReply(body, name, args) {
  const direct = body.tools?.some(({ function: fn }) => fn?.name === name);
  return { finishReason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
    id: "call_" + name, type: "function", function: {
      name: direct ? name : "tool_call", arguments: JSON.stringify(direct ? args : { calls: [{ name, arguments: args }] }),
    },
  }] } };
}
const answer = (content, holdAfterMessage) => ({ message: { role: "assistant", content }, holdAfterMessage });
async function port(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function completed(runtime, assignment) {
  return until(async () => {
    const observed = await runtime.inspectAssignment(assignment);
    return observed.status === "completed" ? observed : false;
  }, "The native fixture turn did not complete");
}

test("concurrent native worker reports drive prioritized isolated management while foreground remains responsive", { timeout: 150_000 }, async (t) => {
  const program = process.env.PRAXIS_HERMES_BIN;
  assert.ok(program, "Set PRAXIS_HERMES_BIN to the pinned Hermes executable.");
  const dir = await mkdtemp(join(tmpdir(), "praxis-management-live-"));
  const home = join(dir, ".hermes");
  const db = join(dir, "state.sqlite");
  const store = new OperationalStore(db);
  const reopened = new OperationalStore(db);
  store.recordTask(task);
  store.recordSession(fore);
  for (const worker of workers) store.recordSession(worker.session);
  const backgroundMcp = key();
  const workerMcp = key();
  const backgroundKey = key();
  const defaultKey = key();
  const grant = { principalId: "principal_fixture_background", tokenDigest: digest(backgroundMcp),
    taskIds: [task.id], sessions: [], actionKinds: [] };
  const reporter = { principalId: "principal_fixture_reporting", tokenDigest: digest(workerMcp), taskIds: [task.id],
    sessions: workers.map(({ session }) => ({ sessionId: session.id, canReport: true })), actionKinds: [] };
  const mcp = createPraxisMcpServer({ store, grants: [grant, reporter] });
  const mcpOrigin = `http://127.0.0.1:${await port(mcp)}/mcp`;
  const held = Promise.withResolvers();
  let gateway;
  let provider;
  const backgroundInputs = [];
  let foregroundObserved = false;
  let readonlyDenied = false;
  t.after(async () => {
    held.resolve();
    await stopProcess(gateway);
    await provider?.close();
    await close(mcp);
    reopened.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  provider = await providerFixture((body) => {
    const user = body.messages.filter(({ role }) => role === "user").map(({ content }) => JSON.stringify(content));
    const has = (text) => user.some((part) => part.includes(text));
    const result = body.messages.findLast(({ role }) => role === "tool");
    if (!body.tools?.length) return answer("Auxiliary fixture.");
    const worker = workers.find(({ prompt }) => has(prompt));
    if (worker) {
      if (result) return answer("Worker report submitted.");
      return toolReply(body, "mcp__praxis__report_worker", {
        sessionId: worker.session.id, phase: worker.phase, message: worker.text,
        submissionId: `event_native_${worker.phase}`, occurredAt: "2026-09-24T10:00:00Z",
      });
    }
    if (has("Independent foreground fixture.")) {
      foregroundObserved = user.every((message) => !message.includes(direction) && !message.includes(maintenance));
      return answer("Foreground remained responsive.");
    }
    if (has("Review this scoped Praxis background work.")) {
      const matching = [direction, maintenance, ...workers.map(({ text }) => text)].filter(has);
      backgroundInputs.push(matching);
      if (has(direction) && !result) {
        return toolReply(body, "mcp__praxis__request_action", {
          kind: "session.stop", target: { kind: "session", id: workers[0].session.id },
          submissionId: "event_background_forbidden", occurredAt: "2026-09-24T10:00:00Z",
        });
      }
      if (has(direction)) readonlyDenied = JSON.stringify(result?.content).includes("forbidden");
      return answer("Scoped background advisory response.", held.promise);
    }
    return answer("Fixture fallback.");
  });

  const reserve = createServer();
  const gatewayPort = await port(reserve);
  await close(reserve);
  const env = {
    PATH: process.env.PATH, HOME: dir, HERMES_HOME: home, HERMES_DISABLE_LAZY_INSTALLS: "1",
    HERMES_NO_SYSTEMD: "1", TERM: "dumb", API_SERVER_ENABLED: "true", API_SERVER_HOST: "127.0.0.1",
    API_SERVER_PORT: String(gatewayPort), API_SERVER_KEY: defaultKey, OPENAI_API_KEY: "fixture-only",
  };
  await mkdir(home);
  const { stdout: version } = await execute(program, ["--version"], { env, timeout: 10_000 });
  assert.match(version, /Hermes Agent v0\.23\.3/);
  t.diagnostic(version.split("\n").filter((line) => /^(Hermes Agent|Python:)/.test(line)).join("\n"));
  await execute(program, ["profile", "create", profile, "--no-credentials", "--no-alias", "--no-skills"], { env, timeout: 25_000 });
  const config = (auth) => [
    "model:", "  provider: custom", `  base_url: ${provider.origin}`, "  default: fake-model",
    "  context_length: 128000", "updates:", "  check: false", "kanban:", "  dispatch_in_gateway: false",
    "mcp_servers:", "  praxis:", `    url: "${mcpOrigin}"`, "    headers:",
    `      Authorization: "Bearer ${auth}"`, "    trust: full",
  ].join("\n");
  await writeFile(join(home, "config.yaml"), config(workerMcp), { mode: 0o600 });
  const backgroundHome = join(home, "profiles", profile);
  await writeFile(join(backgroundHome, ".env"), `API_SERVER_KEY=${backgroundKey}\nOPENAI_API_KEY=fixture-only\n`, { mode: 0o600 });
  await writeFile(join(backgroundHome, "config.yaml"), config(backgroundMcp), { mode: 0o600 });
  gateway = spawn(program, ["-p", "default", "gateway", "run"], { env, stdio: ["ignore", "ignore", "ignore"] });
  const defaultOrigin = `http://127.0.0.1:${gatewayPort}`;
  const backgroundOrigin = `${defaultOrigin}/p/${profile}`;
  const foreground = new HermesRuntime({ origin: defaultOrigin, apiKey: defaultKey });
  const background = new HermesRuntime({ origin: backgroundOrigin, apiKey: backgroundKey });
  await until(async () => {
    try { return (await background.capabilities()).submission.available; } catch { return false; }
  }, "The named native background gateway did not become ready");

  const coordinator = (state) => new ManagementService({
    store: state, runtime: background, profile: backgroundOrigin, principalId: grant.principalId,
    loadGrant: async () => grant, concurrency: 2, maxAttempts: 2, pollMs: 100,
  });
  const first = coordinator(store);
  await first.enqueue({ id: "event_fixture_maintenance", taskId: task.id, kind: "maintenance", instruction: maintenance });
  const reports = await Promise.all(workers.map(({ session, prompt }) => foreground.createAssignment(session, prompt)));
  await Promise.all(reports.map((assignment) => completed(foreground, assignment)));
  assert.equal(store.eventsOfKind("worker.question").length, 1);
  assert.equal(store.eventsOfKind("worker.result").length, 1);
  await first.enqueue({ id: "event_fixture_direction", taskId: task.id, kind: "direction", instruction: direction });
  await first.advance();
  const active = store.management.list().filter(({ state }) => state === "active");
  assert.equal(active.length, 2);
  assert.ok(active.some(({ work }) => work.kind === "direction"));
  assert.ok(active.every(({ work, runId }) => work.kind !== "maintenance" && runId !== undefined));
  await until(() => readonlyDenied && backgroundInputs.length >= 3,
    "The named native profile did not reach both queued turns and its readonly response");
  const foregroundTurn = await foreground.submitTurn(fore, "Independent foreground fixture.", "foreground-fixture");
  assert.match((await completed(foreground, foregroundTurn)).output.text, /Foreground remained responsive/);
  assert.equal(foregroundObserved, true);
  for (const { session, runId } of active) {
    assert.equal((await background.inspectAssignment({ schemaVersion: 1, taskId: task.id, sessionId: session.id, runId })).status, "running");
  }

  held.resolve();
  const afterRestart = coordinator(reopened);
  await until(async () => {
    await afterRestart.advance();
    return reopened.management.list().filter(({ state }) => state === "completed").length === 4;
  }, "The reopened coordinator did not complete the saved and queued native work");
  const final = reopened.management.list();
  assert.equal(new Set(final.map(({ session }) => session.id)).size, 4);
  assert.ok(final.every(({ attempt, result }) => attempt === 1 && result.text === "Scoped background advisory response."));
  assert.ok(backgroundInputs.every((markers) => markers.length === 1), "Each native background context contained exactly its own work");
  assert.equal(reopened.eventsOfKind("management.completed").length, 4);
  const usage = reopened.eventsOfKind("management.usage");
  assert.equal(usage.length, 4);
  assert.ok(usage.every(({ subject }) => reopened.getUsage(subject.id).metering === "reported"));
  assert.deepEqual(reopened.eventsOfKind("action.requested"), []);
  assert.deepEqual(reopened.eventsOfKind("usage.observed"), []);
  t.diagnostic("Two real MCP worker report receipts, bounded prioritized named background runs, readonly action denial, foreground progress, restart and separate metering passed.");
});
