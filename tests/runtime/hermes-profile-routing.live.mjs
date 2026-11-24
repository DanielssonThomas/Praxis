import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { OperationalStore } from "@praxis/state";
import { startShell, stopProcess, until } from "./hermes-fixture.mjs";

const manager = "praxis-manager";
const other = "fixture-other";
const hermesCommit = "caafe5389ae585ef77387a962aee05b1bcf17029";
const execute = promisify(execFile);
const scopedEndpoint = (origin, profile) => profile ? `${origin}/p/${profile}` : origin;

async function listen(onRequest) {
  const server = createServer(onRequest);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    origin: `http://127.0.0.1:${server.address().port}`,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function sandboxProvider() {
  const profiles = new Map([
    ["/manager/v1", { output: "manager fixture output", key: randomUUID() }],
    ["/other/v1", { output: "other fixture output", key: randomUUID() }],
  ]);
  const observed = new Set();
  const mainRequests = [];
  const server = await listen(async (request, response) => {
    const prefix = request.url?.replace(/\/(chat\/completions|models)$/, "");
    const fixture = profiles.get(prefix);
    if (!fixture || request.headers.authorization !== `Bearer ${fixture.key}`) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === "GET" && request.url === `${prefix}/models`) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== `${prefix}/chat/completions`) {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { messages, stream, tools } = JSON.parse(Buffer.concat(chunks).toString());
      observed.add(prefix);
      // Hermes sends auxiliary calls such as session titling without tools.
      if (tools?.length) mainRequests.push({ prefix, messages });
      const metadata = { id: "chatcmpl-routing-fixture", created: 1, model: "fake-model" };
      const message = { role: "assistant", content: fixture.output };
      const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
      if (stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const event = (choices, extra) => `data: ${JSON.stringify({
          ...metadata, object: "chat.completion.chunk", choices, ...extra,
        })}\n\n`;
        response.write(event([{ index: 0, delta: message, finish_reason: null }]));
        response.write(event([{ index: 0, delta: {}, finish_reason: "stop" }]));
        response.write(event([], { usage }));
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ...metadata, object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: "stop" }], usage,
      }));
    } catch {
      response.writeHead(400).end();
    }
  });
  return { ...server, profiles, observed, mainRequests };
}

let directory;
let provider;
let gateway;
let gatewayLaunch;
let origin;
let profileKeys;
let rootKey;

function request(endpoint, key, route, options = {}) {
  return fetch(endpoint + route, {
    ...options,
    headers: { ...options.headers, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    redirect: "error",
    signal: AbortSignal.timeout(4_000),
  });
}

async function expectHttp(response, status) {
  assert.equal(response.status, status, `${new URL(response.url).pathname} returned unexpected status`);
  await response.body?.cancel();
}

async function prepareProfile(executable, env, profile, suffix) {
  const result = await execute(executable, [
    "profile", "create", profile, "--no-credentials", "--no-alias", "--no-skills",
  ], { env, timeout: 25_000 });
  assert.ok(result.stdout.includes(`Profile '${profile}' created`), "Hermes did not create the fixture profile");
  const home = join(env.HERMES_HOME, "profiles", profile);
  await writeFile(join(home, ".env"), `API_SERVER_KEY=${profileKeys.get(profile)}\n`, { mode: 0o600 });
  const prefix = `/${suffix}/v1`;
  const config = [
    "model:",
    "  provider: custom",
    `  base_url: ${provider.origin + prefix}`,
    "  default: fake-model",
    `  api_key: ${provider.profiles.get(prefix).key}`,
    "  context_length: 128000",
    "tools:",
    "  connectors:",
    "    enabled: false",
    "kanban:",
    "  dispatch_in_gateway: false",
    "",
  ].join("\n");
  await writeFile(join(home, "config.yaml"), config, { mode: 0o600 });
}

before(async () => {
  const executable = process.env.PRAXIS_HERMES_BIN;
  assert.ok(executable, "Set PRAXIS_HERMES_BIN to the pinned Hermes executable with messaging dependencies");
  directory = await mkdtemp(join(tmpdir(), "praxis-profile-routing-"));
  const hermesRoot = join(directory, "isolated-hermes");
  await mkdir(hermesRoot);
  provider = await sandboxProvider();
  rootKey = randomUUID();
  profileKeys = new Map([[manager, randomUUID()], [other, randomUUID()]]);
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    HERMES_HOME: hermesRoot,
    HERMES_DISABLE_LAZY_INSTALLS: "1",
    HERMES_NO_SYSTEMD: "1",
    TERM: "dumb",
  };
  const version = await execute(executable, ["--version"], { env, timeout: 15_000 });
  assert.match(version.stdout, /Hermes Agent v0\.23\.3\b/);
  const sourceDirectory = /^Install directory:\s*(.+)$/m.exec(version.stdout)?.[1];
  assert.ok(sourceDirectory, "The pinned fixture must be a Git source installation");
  const revision = await execute("git", ["-C", sourceDirectory, "rev-parse", "HEAD"], { env, timeout: 5_000 });
  assert.equal(revision.stdout.trim(), hermesCommit);

  await writeFile(join(hermesRoot, "config.yaml"), [
    "gateway:", "  multiplex_profiles: true", "updates:", "  check: false",
    "kanban:", "  dispatch_in_gateway: false", "",
  ].join("\n"));
  await prepareProfile(executable, env, manager, "manager");
  await prepareProfile(executable, env, other, "other");
  const reserved = await listen();
  const port = reserved.port;
  await reserved.close();
  origin = reserved.origin;
  gatewayLaunch = {
    executable,
    environment: {
      ...env,
      API_SERVER_ENABLED: "true",
      API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: String(port),
      API_SERVER_KEY: rootKey,
    },
  };
  await startGateway();
}, { timeout: 90_000 });

async function startGateway() {
  gateway = spawn(gatewayLaunch.executable, ["gateway", "run"], {
    env: gatewayLaunch.environment,
    stdio: "ignore",
  });
  await until(async () => {
    assert.equal(gateway.exitCode, null, "Hermes exited before its multiplexed API became ready");
    try {
      const response = await request(scopedEndpoint(origin, manager), profileKeys.get(manager), "/v1/capabilities");
      await response.body?.cancel();
      return response.ok;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return false;
    }
  }, "Hermes did not expose the authenticated manager profile route");
}

after(async () => {
  try {
    await stopProcess(gateway);
    await provider?.close();
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function nativeRun(profile) {
  const endpoint = scopedEndpoint(origin, profile);
  const key = profileKeys.get(profile);
  const id = randomUUID();
  const started = await request(endpoint, key, "/v1/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": id },
    body: JSON.stringify({ input: "Return the local fixture output.", session_id: id }),
  });
  assert.equal(started.status, 202);
  const { run_id: runId } = await started.json();
  assert.match(runId, /^[a-zA-Z0-9_-]+$/);
  const path = "/v1/runs/" + runId;
  const output = await until(async () => {
    const response = await request(endpoint, key, path);
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.notEqual(receipt.status, "failed");
    return receipt.status === "completed" ? receipt.output : false;
  }, `Hermes did not complete the ${profile} fixture run`);
  return { path, output };
}

test("native Hermes routes positive runs and rejects foreign bearers and run IDs", { timeout: 120_000 }, async (t) => {
  await expectHttp(await request(origin, rootKey, "/v1/capabilities"), 200);
  for (const profile of [manager, other]) {
    const endpoint = scopedEndpoint(origin, profile);
    const key = profileKeys.get(profile);
    const foreign = profileKeys.get(profile === manager ? other : manager);
    await expectHttp(await request(endpoint, key, "/v1/capabilities"), 200);
    await expectHttp(await request(endpoint, undefined, "/v1/capabilities"), 401);
    await expectHttp(await request(endpoint, rootKey, "/v1/capabilities"), 401);
    await expectHttp(await request(endpoint, foreign, "/v1/capabilities"), 401);
    await expectHttp(await request(origin, key, "/v1/capabilities"), 401);
  }
  const managerRun = await nativeRun(manager);
  const otherRun = await nativeRun(other);
  assert.equal(managerRun.output, "manager fixture output");
  assert.equal(otherRun.output, "other fixture output");
  assert.notEqual(managerRun.path, otherRun.path);
  for (const [endpoint, key, foreignPath] of [
    [origin, rootKey, managerRun.path],
    [origin, rootKey, otherRun.path],
    [scopedEndpoint(origin, manager), profileKeys.get(manager), otherRun.path],
    [scopedEndpoint(origin, other), profileKeys.get(other), managerRun.path],
  ]) {
    await expectHttp(await request(endpoint, key, foreignPath), 404);
    await expectHttp(await request(endpoint, key, foreignPath + "/stop", { method: "POST" }), 404);
  }
  assert.deepEqual(provider.observed, new Set(["/manager/v1", "/other/v1"]));
  t.diagnostic("Pinned Hermes accepted each named profile's own bearer and run. The default and sibling routes hid foreign run reads and stops.");
});

test("Praxis delivers the assignment lifecycle to the selected Hermes profile", { timeout: 120_000 }, async (t) => {
  const endpoint = scopedEndpoint(origin, manager);
  const key = profileKeys.get(manager);
  const unscoped = new HermesRuntime({ origin, apiKey: key });
  await assert.rejects(unscoped.capabilities(), { code: "unauthorized" });
  const runtime = new HermesRuntime({ origin: endpoint, apiKey: key });
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.submission.available, true);
  assert.equal(capabilities.inspection.available, true);
  const task = { schemaVersion: 1, id: "task_profile_routing", title: "Named Hermes route fixture" };
  const session = { schemaVersion: 1, id: "session_profile_routing", taskId: task.id };
  const assignment = await runtime.createAssignment(session, "Return the selected Praxis manager fixture output.");
  const snapshot = await until(async () => {
    const result = await runtime.inspectAssignment(assignment);
    assert.notEqual(result.status, "failed");
    return result.status === "completed" ? result : false;
  }, "Praxis did not observe completion under the manager profile");
  assert.deepEqual(snapshot.output, { availability: "available", text: "manager fixture output", truncated: false });
  const wrongProfile = new HermesRuntime({ origin: scopedEndpoint(origin, other), apiKey: profileKeys.get(other) });
  await assert.rejects(wrongProfile.inspectAssignment(assignment), { code: "not_found" });
  await assert.rejects(wrongProfile.stopAssignment(assignment), { code: "not_found" });
  const defaultProfile = new HermesRuntime({ origin, apiKey: rootKey });
  await assert.rejects(defaultProfile.inspectAssignment(assignment), { code: "not_found" });
  await assert.rejects(defaultProfile.stopAssignment(assignment), { code: "not_found" });
  const unprivileged = new HermesRuntime({ origin: endpoint, apiKey: profileKeys.get(other) });
  await assert.rejects(unprivileged.capabilities(), { code: "unauthorized" });
  const database = join(directory, "state.sqlite");
  const authorityFile = join(directory, "authority.json");
  const store = new OperationalStore(database);
  try {
    store.recordTask(task);
    store.recordSession(session);
  } finally {
    store.close();
  }
  const operator = randomBytes(32).toString("base64url");
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  await writeFile(authorityFile, JSON.stringify({
    schemaVersion: 1,
    database,
    grants: [{
      principalId: "principal_profile_fixture",
      tokenDigest: digest(randomBytes(32)),
      taskIds: [task.id],
      sessions: [{ sessionId: session.id, canReport: false, assignment }],
      actionKinds: [],
    }],
  }), { mode: 0o600 });
  const shell = await startShell(directory, {
    PRAXIS_HERMES_ORIGIN: endpoint,
    PRAXIS_HERMES_API_KEY: key,
    PRAXIS_MCP_CONFIG_FILE: authorityFile,
    PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator),
  });
  t.after(() => stopProcess(shell.processHandle));
  const overview = await fetch(new URL("/api/overview", shell.origin), {
    headers: { Authorization: `Bearer ${operator}` },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(overview.status, 200);
  const { panes } = await overview.json();
  assert.equal(panes.length, 1);
  assert.deepEqual(panes[0].runtime.snapshot, snapshot);
  t.diagnostic("The Praxis runtime and configured Overview used the same named profile run, and default and sibling runtime instances could neither inspect nor stop it.");
});


test("named Hermes preserves follow-up history, separate sessions and retry receipts", { timeout: 150_000 }, async (t) => {
  const endpoint = scopedEndpoint(origin, manager);
  const key = profileKeys.get(manager);
  const runtime = new HermesRuntime({ origin: endpoint, apiKey: key });
  const reconnected = new HermesRuntime({ origin: endpoint, apiKey: key });
  const sibling = new HermesRuntime({ origin: scopedEndpoint(origin, other), apiKey: profileKeys.get(other) });
  const session = { schemaVersion: 1, id: "session_named_follow_up", taskId: "task_named_follow_up" };
  const independent = { ...session, id: "session_named_follow_up_independent" };
  const initialPrompt = "First named-session marker apple-31.";
  const nextPrompt = "Continue the named session using the previous marker.";
  const independentPrompt = "Independent named-session marker lime-72.";
  const changedPrompt = "Conflicting replacement of the admitted turn.";
  const turnId = "turn_native_fixture";
  const attemptStart = provider.mainRequests.length;

  const complete = (adapter, assignment) => until(async () => {
    const result = await adapter.inspectAssignment(assignment);
    assert.notEqual(result.status, "failed");
    return result.status === "completed" ? result : false;
  }, "The native turn did not complete");

  const initial = await runtime.submitTurn(session, initialPrompt, "turn_initial_fixture");
  assert.equal((await complete(runtime, initial)).output.text, "manager fixture output");
  const [followUp, replay] = await Promise.all([
    runtime.submitTurn(session, nextPrompt, turnId),
    reconnected.submitTurn(session, nextPrompt, turnId),
  ]);
  assert.notEqual(followUp.runId, initial.runId);
  assert.deepEqual(replay, followUp);
  assert.equal((await complete(reconnected, followUp)).output.text, "manager fixture output");
  assert.deepEqual(await reconnected.submitTurn(session, nextPrompt, turnId), followUp);
  await assert.rejects(reconnected.submitTurn(session, changedPrompt, turnId), {
    code: "native_refused", message: /HTTP 409/,
  });

  const separateRun = await runtime.submitTurn(independent, independentPrompt, turnId);
  assert.equal((await complete(runtime, separateRun)).output.text, "manager fixture output");
  const siblingRun = await sibling.submitTurn(session, nextPrompt, turnId);
  assert.equal((await complete(sibling, siblingRun)).output.text, "other fixture output");
  assert.equal(new Set([initial, followUp, separateRun, siblingRun].map(({ runId }) => runId)).size, 4);
  await assert.rejects(sibling.inspectAssignment(followUp), { code: "not_found" });
  await assert.rejects(reconnected.inspectAssignment(siblingRun), { code: "not_found" });

  const nativeReceipt = async (assignment) => {
    const response = await request(endpoint, key, "/v1/runs/" + assignment.runId);
    assert.equal(response.status, 200);
    return response.json();
  };
  const firstReceipt = await nativeReceipt(initial);
  const nextReceipt = await nativeReceipt(followUp);
  const independentReceipt = await nativeReceipt(separateRun);
  const siblingResponse = await request(scopedEndpoint(origin, other), profileKeys.get(other), "/v1/runs/" + siblingRun.runId);
  assert.equal(siblingResponse.status, 200);
  const siblingReceipt = await siblingResponse.json();
  assert.equal(firstReceipt.session_id, nextReceipt.session_id);
  assert.equal(new Set([firstReceipt, independentReceipt, siblingReceipt].map(({ session_id }) => session_id)).size, 3);

  const readHistory = async ({ session_id: id }) => {
    const response = await request(endpoint, key, `/api/sessions/${id}/messages?order=oldest`);
    assert.equal(response.status, 200);
    const history = await response.json();
    assert.equal(history.session_id, id);
    return history.data.filter(({ role }) => role === "user" || role === "assistant");
  };
  const mainHistory = await readHistory(firstReceipt);
  const isolatedHistory = await readHistory(independentReceipt);
  const contents = (messages) => messages.map(({ content }) => content);
  assert.deepEqual(contents(mainHistory), [initialPrompt, "manager fixture output", nextPrompt, "manager fixture output"]);
  assert.deepEqual(contents(isolatedHistory), [independentPrompt, "manager fixture output"]);

  await stopProcess(gateway);
  await startGateway();
  const afterGatewayRestart = new HermesRuntime({ origin: endpoint, apiKey: key });
  assert.deepEqual(await afterGatewayRestart.submitTurn(session, nextPrompt, turnId), followUp);
  assert.equal((await afterGatewayRestart.inspectAssignment(initial)).output.text, "manager fixture output");
  assert.equal((await afterGatewayRestart.inspectAssignment(followUp)).output.text, "manager fixture output");

  const calls = provider.mainRequests.slice(attemptStart).map(({ prefix, messages }) => {
    const conversation = messages.filter(({ role }) => role === "user" || role === "assistant");
    return { prefix, conversation, input: conversation.at(-1)?.content };
  });
  assert.deepEqual(calls.map(({ prefix, input }) => [prefix, input]), [
    ["/manager/v1", initialPrompt], ["/manager/v1", nextPrompt],
    ["/manager/v1", independentPrompt], ["/other/v1", nextPrompt],
  ]);
  assert.deepEqual(contents(calls[1].conversation), [initialPrompt, "manager fixture output", nextPrompt]);
  assert.deepEqual(contents(calls[2].conversation), [independentPrompt]);
  assert.deepEqual(contents(calls[3].conversation), [nextPrompt]);
  t.diagnostic("Real Hermes preserved the selected profile's conversation on the wire and in its transcript. Concurrent, settled and post-restart retries reused the follow-up run without another main model turn. A changed prompt was refused.");
});
