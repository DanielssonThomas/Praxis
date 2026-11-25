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
import { providerFixture, stopProcess, until } from "./hermes-fixture.mjs";

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

test("the installed Linux manager preserves local edits and loads the pinned policy and Praxis tools", { timeout: 120_000 }, async (t) => {
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
  let installedMcp;
  let provider;
  const store = new OperationalStore(join(directory, "state.sqlite"));
  t.after(async () => {
    await stopProcess(gateway);
    await provider?.close();
    if (installedMcp?.listening) await close(installedMcp);
    store.close();
    await rm(directory, { force: true, recursive: true, maxRetries: 3 });
  });
  store.recordTask(task);
  installedMcp = createPraxisMcpServer({ store, grants: [{
    principalId: "principal_installed_manager", tokenDigest: digest(localToken),
    taskIds: [task.id], sessions: [], actionKinds: [],
  }] });
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
    prompts.push(call.messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n"));
    for (const result of call.messages.filter(({ role }) => role === "tool")) {
      if (JSON.stringify(result.content).includes(task.title)) sawTask = true;
      try {
        const value = JSON.parse(result.content);
        if (schemas.every((name) => value.tools?.[name]?.parameters)) sawSchemas = true;
      } catch {
        // Other tool result formats remain covered by the authenticated task assertion.
      }
    }
    if (sawTask) return reply(finalReply);
    const names = call.tools?.map(({ function: tool }) => tool?.name) ?? [];
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
  const assignment = await runtime.submitTurn({
    schemaVersion: 1, taskId: task.id, id: "session_install_test",
  }, "Read the fixture task using Praxis MCP.", "installed-manager");
  const result = await until(async () => {
    const snapshot = await runtime.inspectAssignment(assignment);
    assert.notEqual(snapshot.status, "failed");
    return snapshot.status === "completed" ? snapshot : false;
  }, "The installed Hermes manager did not finish its native turn");
  assert.equal(result.output.text, finalReply);
  assert.equal(sawSchemas, true);
  assert.equal(sawTask, true);
  const receipt = await fetch(`${base}/v1/runs/${assignment.runId}`, {
    headers: { Authorization: `Bearer ${managerKey}` }, redirect: "error",
  });
  assert.equal(receipt.status, 200);
  assert.equal(inspectHermesActivation(target, (await receipt.json()).session_id).loaded.status, "passed");
  const core = (await readFile(join(axiom, "core", "AXIOMS.md"), "utf8")).trim();
  assert.ok(prompts.some((prompt) => observedPolicy(prompt) === `Axiom policy digest ${setup.policy.digest}\n\n${core}`));
  assert.ok(prompts.some((prompt) => skills.every((name) => prompt.includes("axiom:" + name))));
  assert.ok(prompts.some((prompt) => prompt.includes("Installed manager owner customization.")));
  t.diagnostic("Native setup and its explicit update preserved user files. The running profile loaded the exact Axiom core and used scoped Praxis MCP.");
});
