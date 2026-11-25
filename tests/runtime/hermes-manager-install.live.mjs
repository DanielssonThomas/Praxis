import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { createPraxisMcpServer } from "@praxis/mcp";
import { defaultSettings } from "@praxis/settings";
import { OperationalStore } from "@praxis/state";
import { chromium } from "playwright";
import { providerFixture, startShell, stopProcess, until } from "./hermes-fixture.mjs";

const execute = promisify(execFile);
const finalReply = "The named manager read the fixture task.";
const releases = { axiom: "96014e73ca14111be83c448898e41559f0f87f88", hermes: "caafe5389ae585ef77387a962aee05b1bcf17029" };
const skills = ["context", "delegate", "design", "diagnose", "knowledge", "verify"];
const schemas = ["inspect_task", "inspect_worker", "report_worker", "request_action"].map((name) => "mcp__praxis__" + name);
const digest = (value) => createHash("sha256").update(value).digest("hex");

function toolReply(name, args) {
  return { finishReason: "tool_calls", message: {
    role: "assistant", content: null,
    tool_calls: [{ id: "call_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  } };
}

function reply(content) {
  return { message: { role: "assistant", content } };
}

function observedPolicy(prompt) {
  return [...prompt.matchAll(/## Plugin Context: axiom\.policy-\d{3}\n<!-- hermes-plugin-section-chars:(\d+) -->\n\n/g)]
    .map(({ 0: header, 1: length, index }) =>
      Array.from(prompt.slice(index + header.length)).slice(0, Number(length)).join("")).join("\n\n");
}

async function start(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function readTurn(response) {
  assert.equal(response.status, 200);
  const decoded = response.body.pipeThrough(new TextDecoderStream());
  const records = [];
  let partial = "";
  for await (const chunk of decoded) {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop();
    for (const line of lines) {
      const record = JSON.parse(line);
      assert.equal(record.kind, "snapshot");
      records.push(record);
    }
  }
  assert.equal(partial, "");
  assert.equal(records.at(-1)?.snapshot.status, "completed");
  return records.at(-1);
}

test("the installed Linux manager loads its policy and responds while an independent native worker is active", { timeout: 150_000 }, async (t) => {
  const binary = process.env.PRAXIS_HERMES_BIN;
  const axiom = process.env.PRAXIS_AXIOM_ROOT;
  assert.ok(binary && axiom, "Set PRAXIS_HERMES_BIN and PRAXIS_AXIOM_ROOT to the pinned source builds.");
  const load = (file) => import(pathToFileURL(join(axiom, file)));
  const { assembleBundles, writeBundles } = await load("packages/bundles/dist/index.js");
  const { changeHermesPlugin, hermesBundleAdapter, inspectHermesActivation } = await load("adapters/hermes/dist/index.js");

  const directory = await mkdtemp(join(tmpdir(), "praxis-manager-real-"));
  const home = join(directory, "dedicated-hermes");
  const userHome = join(directory, "user");
  const original = join(userHome, ".hermes");
  const settingsFile = join(directory, "settings.json");
  const task = { schemaVersion: 1, id: "task_installed_manager", title: "Installed Praxis manager fixture" };
  const worker = { schemaVersion: 1, taskId: task.id, id: "session_foreground_fixture_worker" };
  const foreign = { schemaVersion: 1, id: "task_foreign_card", title: "Foreign task details must stay scoped" };
  const missingCard = "task_missing_card";
  const resourceFooter = [
    `[[praxis:task:${task.id}]]`, `[[praxis:session:${worker.id}]]`, `[[praxis:task:${missingCard}]]`,
    `[[praxis:task:${foreign.id}]]`, `[[praxis:task:${worker.id}]]`, `[[praxis:task:${task.id}]]`,
  ].join("\n");
  const workerPrompt = "Hold the distinct fixture worker until the operator decides.";
  const unknownPrompt = "Read the unavailable fixture task.";
  const disabledPrompt = "Show relevant cards with automatic presentation disabled.";
  const disabledReply = "The work remains available in the conversation.";
  const actionPrompts = new Map([
    ["Cancel the active fixture worker.", { kind: "session.stop", target: { kind: "session", id: worker.id } }],
    ["Delegate the fixture task.", { kind: "task.delegate", target: { kind: "task", id: task.id } }],
    ["Reprioritize the fixture task.", { kind: "task.reprioritize", target: { kind: "task", id: task.id } }],
  ]);
  const profile = "praxis-fixture-manager";
  const profileHome = join(home, "profiles", profile);
  const nativeEnv = { PATH: process.env.PATH, HOME: userHome, PRAXIS_CONFIG_FILE: settingsFile };
  const localToken = randomBytes(32).toString("base64url");
  const managerKey = randomUUID();

  await mkdir(join(original, "sessions"), { recursive: true });
  await writeFile(join(settingsFile), JSON.stringify({
    ...defaultSettings(), manager: { ...defaultSettings().manager, profile },
  }));
  const sentinels = {
    ".env": "OPENAI_API_KEY=local-root-do-not-copy\n",
    "auth.json": '{"version":1,"providers":{"openai-codex":{"access_token":"inert-root-login"}}}',
    "sessions/original.jsonl": "local history that must stay in the user's original home",
  };
  for (const [file, value] of Object.entries(sentinels)) await writeFile(join(original, file), value);

  let gateway;
  let shell;
  let browser;
  let releaseWorker;
  let releaseForeground;
  const holdWorker = new Promise((resolve) => { releaseWorker = resolve; });
  const holdForeground = new Promise((resolve) => { releaseForeground = resolve; });
  let installedMcp;
  let provider;
  const store = new OperationalStore(join(directory, "state.sqlite"));
  t.after(async () => {
    releaseWorker();
    releaseForeground();
    await browser?.close();
    await stopProcess(shell?.processHandle);
    await stopProcess(gateway);
    await provider?.close();
    if (installedMcp?.listening) await close(installedMcp);
    store.close();
    await rm(directory, { force: true, recursive: true, maxRetries: 3 });
  });
  store.recordTask(task);
  store.recordTask(foreign);
  store.recordSession(worker);
  const grant = {
    principalId: "principal_installed_manager", tokenDigest: digest(localToken),
    taskIds: [task.id, missingCard], sessions: [{ sessionId: worker.id, canReport: false }],
    actionKinds: [...actionPrompts.values()].map(({ kind }) => kind),
  };
  installedMcp = createPraxisMcpServer({ store, grants: [grant] });
  const mcp = `http://127.0.0.1:${await start(installedMcp)}/mcp`;

  const runInstall = (...extra) => execute(process.execPath, [
    "scripts/install-hermes-manager.mjs", "--hermes-bin", binary, "--hermes-home", home,
    "--axiom-root", axiom, "--mcp-origin", mcp, ...extra,
  ], { env: nativeEnv, timeout: 30_000 });
  const setup = JSON.parse((await runInstall()).stdout);
  assert.equal(setup.profile, profile);
  assert.equal(setup.home, home);
  assert.equal(setup.policy.status, "enabled");
  const config = join(profileHome, "config.yaml");
  const soul = join(profileHome, "SOUL.md");
  const credentialFile = join(profileHome, ".env");
  assert.match(await readFile(soul, "utf8"), /concise, professional engineering manager/);
  assert.match(await readFile(soul, "utf8"), /\[\[praxis:task:task_EXAMPLE\]\].*\[\[praxis:session:session_EXAMPLE\]\]/);
  assert.match(await readFile(config, "utf8"), /\$\{PRAXIS_MCP_TOKEN\}/);
  assert.doesNotMatch(await readFile(credentialFile, "utf8"), /local-root-do-not-copy/);
  for (const file of ["auth.json", "sessions/original.jsonl"]) {
    await assert.rejects(readFile(join(profileHome, file)), { code: "ENOENT" });
  }

  let sawSchemas = false;
  let sawTask = false;
  let described = false;
  const prompts = [];
  provider = await providerFixture((call) => {
    const names = call.tools?.map(({ function: tool }) => tool?.name) ?? [];
    if (!names.length) return reply("Fixture title");
    const lastUser = call.messages.findLastIndex(({ role }) => role === "user");
    const input = call.messages[lastUser]?.content;
    if (input === workerPrompt) return { ...reply("Distinct worker output"), holdAfterMessage: holdWorker };
    if (input === disabledPrompt) return reply(`${disabledReply}\n\n${resourceFooter}`);

    const recent = call.messages.slice(lastUser + 1).filter(({ role }) => role === "tool");
    const invoke = (name, args) => names.includes(name)
      ? toolReply(name, args)
      : toolReply("tool_call", { calls: [{ name, arguments: args }] });
    const action = actionPrompts.get(input);
    if (action) {
      if (recent.length) return reply(recent.some(({ content }) => JSON.stringify(content).includes("pending"))
        ? "The scoped action request is pending review." : "The scoped action request was refused.");
      return invoke("mcp__praxis__request_action", { ...action,
        occurredAt: new Date().toISOString(), submissionId: "event_foreground_" + action.kind,
      });
    }
    if (input === unknownPrompt) {
      if (recent.length) return reply(recent.some(({ content }) => JSON.stringify(content).includes("forbidden"))
        ? "The requested information is unavailable in my scope." : "The tool returned unexpected information.");
      return invoke(schemas[0], { taskId: "task_unavailable" });
    }

    prompts.push(call.messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n"));
    for (const result of recent) {
      if (JSON.stringify(result.content).includes(task.title)) sawTask = true;
      try {
        const value = JSON.parse(result.content);
        if (schemas.every((name) => value.tools?.[name]?.parameters)) sawSchemas = true;
      } catch {
        // Other tool result formats remain covered by the authenticated task assertion.
      }
    }
    if (sawTask) return { ...reply(`${finalReply}\n\n${resourceFooter}`), holdAfterMessage: holdForeground };
    if (schemas.every((name) => names.includes(name))) sawSchemas = true;
    if (!described && !sawSchemas && names.includes("tool_describe")) {
      described = true;
      return toolReply("tool_describe", { names: schemas });
    }
    if (names.includes(schemas[0])) return toolReply(schemas[0], { taskId: task.id });
    if (names.includes("tool_call")) return toolReply("tool_call", { calls: [
      { name: schemas[0], arguments: { taskId: task.id } },
    ] });
    return reply("The native run could not discover the Praxis inspector.");
  });

  await appendFile(soul, "\nInstalled manager owner customization.\n");
  await appendFile(config, [
    "\nmodel:",
    "  provider: custom",
    `  base_url: ${provider.origin}`,
    "  default: fake-model",
    "  api_key: fixture-only-provider-key",
    "  context_length: 128000",
    "kanban:",
    "  dispatch_in_gateway: false",
    "",
  ].join("\n"));
  await appendFile(credentialFile, `\nAPI_SERVER_KEY=${managerKey}\nPRAXIS_MCP_TOKEN=${localToken}\n`);

  const target = { home, profile };
  const expected = inspectHermesActivation(target);
  const userFiles = new Map();
  for (const path of [config, soul, credentialFile]) userFiles.set(path, await readFile(path, "utf8"));
  assert.deepEqual(JSON.parse((await runInstall()).stdout), setup);
  for (const [path, value] of userFiles) assert.equal(await readFile(path, "utf8"), value);

  const [older] = writeBundles(join(directory, "older-bundle"), assembleBundles(axiom, {
    version: "0.0.9", sourceRevision: releases.axiom, policyVersion: "1",
    selectedProfiles: [], checks: {}, skills: skills.map((id) => ({ id })), adapters: [hermesBundleAdapter],
  }));
  assert.deepEqual(changeHermesPlugin(target, { kind: "update", bundle: older.directory }), {
    outcome: { status: "passed" }, changed: true,
  });
  await assert.rejects(runInstall(), ({ stderr }) => /Use --update/.test(stderr));
  assert.equal(inspectHermesActivation(target).bundleDigest, older.manifest.digest);
  assert.deepEqual(JSON.parse((await runInstall("--update")).stdout), setup);
  assert.equal(inspectHermesActivation(target).bundleDigest, expected.bundleDigest);
  for (const [path, value] of userFiles) assert.equal(await readFile(path, "utf8"), value);
  for (const [file, value] of Object.entries(sentinels)) assert.equal(await readFile(join(original, file), "utf8"), value);

  const enabledSettings = await readFile(settingsFile, "utf8");
  const optedOut = JSON.parse(enabledSettings);
  optedOut.policy.axiomEnabled = false;
  await writeFile(settingsFile, JSON.stringify(optedOut));
  assert.deepEqual(JSON.parse((await runInstall()).stdout).policy, { status: "preserved" });
  assert.equal(inspectHermesActivation(target).enabled, true);
  await writeFile(settingsFile, enabledSettings);

  const launchEnv = { ...nativeEnv, HERMES_HOME: home, HERMES_NO_SYSTEMD: "1", HERMES_DISABLE_LAZY_INSTALLS: "1" };
  const version = await execute(binary, ["--version"], { env: launchEnv, timeout: 10_000 });
  const source = /^Install directory:\s*(.+)$/m.exec(version.stdout)?.[1];
  assert.ok(source);
  const nativeRevision = await execute("git", ["-C", source, "rev-parse", "HEAD"], { env: launchEnv });
  assert.equal(nativeRevision.stdout.trim(), releases.hermes);
  const reserve = createServer();
  const port = await start(reserve);
  await close(reserve);
  const base = `http://127.0.0.1:${port}/p/${profile}`;
  gateway = spawn(binary, ["-p", "default", "gateway", "run"], {
    env: { ...launchEnv, API_SERVER_ENABLED: "true", API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: String(port), API_SERVER_KEY: randomUUID() },
    stdio: "ignore",
  });
  const runtime = new HermesRuntime({ origin: base, apiKey: managerKey });
  await until(async () => {
    assert.equal(gateway.exitCode, null);
    try {
      return (await runtime.capabilities()).submission.available;
    } catch (error) {
      if (error.code !== "unavailable") throw error;
      return false;
    }
  }, "The installed Hermes manager did not open its native route");
  const workerAssignment = await runtime.createAssignment(worker, workerPrompt);
  await until(async () => (await runtime.inspectAssignment(workerAssignment)).status === "running",
    "The independent worker did not start");
  const authority = join(directory, "authority.json");
  await writeFile(authority, JSON.stringify({ schemaVersion: 1, database: join(directory, "state.sqlite"), grants: [
    { ...grant, sessions: [{ ...grant.sessions[0], assignment: workerAssignment }] },
    { principalId: "principal_foreign_card", tokenDigest: digest(randomUUID()), taskIds: [foreign.id], sessions: [], actionKinds: [] },
  ] }), { mode: 0o600 });
  const operator = randomBytes(32).toString("base64url");
  shell = await startShell(directory, {
    PRAXIS_MCP_CONFIG_FILE: authority, PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator),
    PRAXIS_HERMES_ORIGIN: base, PRAXIS_HERMES_API_KEY: managerKey,
    PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID: grant.principalId,
  });
  const privateCall = (path, payload) => fetch(new URL(path, shell.origin), {
    method: payload === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${operator}`, Origin: new URL(shell.origin).origin, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const requestTurn = (turnId, prompt) => privateCall("/api/manager/turn", { turnId, prompt });
  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.setDefaultTimeout(12_000);
  const submissions = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/manager/turn" && request.method() === "POST") {
      submissions.push(request.postDataJSON());
    }
  });
  await page.goto(shell.origin);
  async function openManager() {
    await page.getByRole("form", { name: "Open Manager" }).getByLabel("Operator token").fill(operator);
    await page.getByRole("button", { name: "Open manager", exact: true }).click();
    await page.getByRole("button", { name: "Lock manager", exact: true }).waitFor();
  }
  async function command(text) {
    const input = page.getByRole("textbox", { name: "Command", exact: true });
    await input.fill(text);
    await input.press("Enter");
  }
  await openManager();
  const firstPrompt = "Read the fixture task using Praxis MCP.";
  await command(firstPrompt);
  await page.getByText(finalReply, { exact: true }).waitFor();
  assert.equal((await runtime.inspectAssignment(workerAssignment)).status, "running");
  await command("/o");
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await command("/m");
  await page.getByRole("heading", { name: "Manager", exact: true }).waitFor();
  await page.getByText(finalReply, { exact: true }).waitFor();

  await page.getByRole("button", { name: "Lock manager", exact: true }).click();
  await openManager();
  // Clone at the browser's fetch boundary before either reader starts consuming the replay stream.
  const replay = await page.evaluateHandle(() => {
    const originalFetch = window.fetch;
    const body = new Promise((resolve, reject) => {
      window.fetch = (url, options) => {
        const response = originalFetch.call(window, url, options);
        if (url === "/api/manager/turn" && options?.method === "POST") {
          window.fetch = originalFetch;
          void response.then((value) => value.clone().text()).then(resolve, reject);
        }
        return response;
      };
    });
    return { body };
  });
  const resumed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/manager/turn"
    && response.request().method() === "POST");
  const beforeReconnect = prompts.length;
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  const replayResponse = await resumed;
  assert.equal(replayResponse.status(), 200);
  releaseForeground();
  const records = (await replay.evaluate(({ body }) => body)).trim().split("\n").map(JSON.parse);
  await replay.dispose();
  const result = records.at(-1);
  assert.equal(result.snapshot.status, "completed");
  await page.locator("#manager-status").waitFor({ state: "hidden" });
  await page.getByText(/Context window and compaction unavailable/).waitFor();
  await page.getByText(/input · .*output tokens/).waitFor();
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions[0], submissions[1]);
  assert.equal(submissions[0].prompt, firstPrompt);
  assert.equal(prompts.length, beforeReconnect);
  assert.equal(await page.getByText(firstPrompt, { exact: true }).count(), 1);
  assert.equal(result.snapshot.sessionId, "session_foreground_manager");
  assert.notEqual(result.runId, workerAssignment.runId);
  assert.equal(result.snapshot.output.text, finalReply);
  assert.deepEqual(result.resources?.map(({ kind }) => kind).sort(), ["session", "task", "unavailable", "unavailable"]);
  assert.ok(!JSON.stringify(result).includes(foreign.id));
  assert.ok(!JSON.stringify(result).includes(foreign.title));
  assert.ok(!JSON.stringify(result).includes(missingCard));
  const taskCard = page.getByRole("article", { name: task.title });
  await taskCard.getByText("Details", { exact: true }).click();
  await taskCard.getByText(task.id, { exact: true }).waitFor();
  const workerCard = page.getByRole("article", { name: "Worker session", exact: true });
  await workerCard.getByText("running", { exact: true }).waitFor();
  await workerCard.getByText("Details", { exact: true }).click();
  await workerCard.getByText(worker.id, { exact: true }).waitFor();
  assert.equal(await page.getByRole("article", { name: "Task unavailable", exact: true }).count(), 2);
  await taskCard.getByRole("button", { name: "Dismiss", exact: true }).click();
  await taskCard.waitFor({ state: "detached" });
  await command("/s");
  const preferences = page.frameLocator('iframe[title="Praxis settings"]');
  await preferences.getByRole("checkbox", { name: "Show relevant cards automatically" }).uncheck();
  await preferences.getByRole("button", { name: "Save settings" }).click();
  await preferences.getByRole("status").getByText("Settings saved.").waitFor();
  await command("/m");
  await command(disabledPrompt);
  const disabledMessage = page.getByRole("listitem").filter({ hasText: disabledReply });
  await disabledMessage.waitFor();
  await page.locator("#manager-status").waitFor({ state: "hidden" });
  assert.equal(await disabledMessage.getByRole("article").count(), 0);
  assert.equal(await page.getByRole("article", { name: "Worker session", exact: true }).count(), 1);
  assert.equal(await page.getByText(foreign.title, { exact: true }).count(), 0);
  assert.equal(sawSchemas, true);
  assert.equal(sawTask, true);
  const receipt = await fetch(`${base}/v1/runs/${result.runId}`, {
    headers: { Authorization: `Bearer ${managerKey}` }, redirect: "error",
  });
  assert.equal(receipt.status, 200);
  assert.equal(inspectHermesActivation(target, (await receipt.json()).session_id).loaded.status, "passed");
  const core = (await readFile(join(axiom, "core", "AXIOMS.md"), "utf8")).trim();
  assert.ok(prompts.some((prompt) => observedPolicy(prompt) === `Axiom policy digest ${setup.policy.digest}\n\n${core}`));
  assert.ok(prompts.some((prompt) => skills.every((name) => prompt.includes("axiom:" + name))));
  assert.ok(prompts.some((prompt) => prompt.includes("Installed manager owner customization.")));
  const missing = await readTurn(await requestTurn("missing", unknownPrompt));
  assert.equal(missing.snapshot.output.text, "The requested information is unavailable in my scope.");

  for (const [index, prompt] of [...actionPrompts.keys()].entries()) {
    const response = await readTurn(await requestTurn("action-" + index, prompt));
    assert.equal(response.snapshot.output.text, "The scoped action request is pending review.");
  }
  assert.equal((await runtime.inspectAssignment(workerAssignment)).status, "running");
  const activity = await (await privateCall("/api/activity")).json();
  assert.equal(activity.length, 3);
  for (const [kind, entry] of activity.map((item) => [item.action.kind, item])) {
    const request = await (await privateCall("/api/activity/inspect", { requestId: entry.requestId })).json();
    assert.equal(entry.actorId, grant.principalId);
    assert.deepEqual(entry.action.target, [...actionPrompts.values()].find((action) => action.kind === kind).target);
    if (kind !== "session.stop") {
      assert.equal(request.state, "refused");
      continue;
    }
    assert.equal(request.state, "attention");
    const approved = await privateCall("/api/activity/decision", {
      requestId: entry.requestId, approvalId: request.approval.id, decision: "approve",
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).state, "resolved");
  }
  releaseWorker();
  await until(async () => (await runtime.inspectAssignment(workerAssignment)).status === "stopped",
    "The approved cancellation did not stop the exact worker");
  t.diagnostic("Chromium recovered the grounded turn, rendered scoped task and live worker cards, hid missing and foreign details, and honored the saved card preference. Scoped Activity remained available.");
});
