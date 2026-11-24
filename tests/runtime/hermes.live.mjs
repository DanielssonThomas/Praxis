import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { runtimeSessionSnapshotSchema } from "@praxis/contracts";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { chromium } from "playwright";

const execute = promisify(execFile);
const holdPrompt = "Wait for the isolated Praxis runtime fixture.";
const finalOutput = "Hermes completed the isolated Praxis fixture.";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function stopProcess(process) {
  if (process === undefined || process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, "exit");
  process.kill();
  const kill = setTimeout(() => process.kill("SIGKILL"), 10_000);
  try {
    await exited;
  } finally {
    clearTimeout(kill);
  }
}

async function until(observe, description, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await observe();
    if (result) return result;
    await delay(150);
  }
  assert.fail(description);
}

async function providerFixture() {
  let holdCalls = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString());
    if (call.messages.some(({ content }) => JSON.stringify(content)?.includes(holdPrompt))) {
      holdCalls += 1;
      await hold;
    }

    const base = { id: "chatcmpl-praxis-fixture", created: 1, model: "fake-model" };
    const usage = { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 };
    if (call.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (choices) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices })}\n\n`;
      response.write(frame([{ index: 0, delta: { role: "assistant", content: finalOutput }, finish_reason: null }]));
      response.write(frame([{ index: 0, delta: {}, finish_reason: "stop" }]));
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: finalOutput }, finish_reason: "stop" }],
        usage,
      }));
    }
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}/v1`, release, holdCalls: () => holdCalls, close: () => closeServer(server) };
}

async function startShell(directory) {
  const processHandle = spawn(process.execPath, ["packages/shell/dist/cli.js"], {
    env: { ...process.env, PRAXIS_PORT: "0", PRAXIS_CONFIG_FILE: join(directory, "settings.json") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const log = await Promise.race([
      once(processHandle.stdout, "data").then(([chunk]) => chunk.toString()),
      once(processHandle, "exit").then(() => { throw new Error("Praxis stopped before listening"); }),
    ]);
    const origin = /http:\/\/127\.0\.0\.1:\d+\//.exec(log)?.[0];
    assert.ok(origin);
    return { processHandle, origin };
  } catch (error) {
    await stopProcess(processHandle);
    throw error;
  }
}

async function waitForState(runtime, assignment, expected) {
  return until(async () => {
    const observed = await runtime.inspectAssignment(assignment);
    return observed.status === expected ? observed : false;
  }, `Hermes never reached ${expected}`);
}

test("real Hermes runs survive closing Praxis and can be inspected and stopped after reopening", { timeout: 120_000 }, async (t) => {
  const executable = process.env.PRAXIS_HERMES_BIN;
  assert.ok(executable, "Set PRAXIS_HERMES_BIN to an installed Hermes executable with the messaging extra");

  const directory = await mkdtemp(join(tmpdir(), "praxis-hermes-live-"));
  const provider = await providerFixture();
  let gateway;
  let browser;
  let shell;
  t.after(async () => {
    provider.release();
    await browser?.close();
    await stopProcess(shell?.processHandle);
    await stopProcess(gateway);
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  });

  const reservedPort = createServer();
  const port = await listen(reservedPort);
  await closeServer(reservedPort);
  const hermesHome = join(directory, ".hermes");
  await mkdir(hermesHome);
  await writeFile(join(hermesHome, "config.yaml"), [
    "model:",
    "  provider: custom",
    `  base_url: ${provider.origin}`,
    "  default: fake-model",
    "  context_length: 128000",
    "updates:",
    "  check: false",
    "kanban:",
    "  dispatch_in_gateway: false",
    "",
  ].join("\n"));

  const apiKey = randomUUID();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    HERMES_HOME: hermesHome,
    HERMES_NO_SYSTEMD: "1",
    TERM: "dumb",
    API_SERVER_ENABLED: "true",
    API_SERVER_HOST: "127.0.0.1",
    API_SERVER_PORT: String(port),
    API_SERVER_KEY: apiKey,
    OPENAI_API_KEY: "fixture-only-provider-key",
  };
  const version = await execute(executable, ["--version"], { env, timeout: 10_000 });
  t.diagnostic(version.stdout.split("\n").filter((line) => /^(Hermes Agent|Python:|OpenAI SDK:)/.test(line)).join("\n"));

  gateway = spawn(executable, ["gateway", "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let gatewayTail = "";
  for (const stream of [gateway.stdout, gateway.stderr]) {
    stream.on("data", (output) => { gatewayTail = (gatewayTail + output).slice(-4_096); });
  }

  const runtime = new HermesRuntime({ origin, apiKey });
  try {
    await until(async () => {
      if (gateway.exitCode !== null) throw new Error("Hermes exited before opening its API");
      try {
        const capabilities = await runtime.capabilities();
        assert.equal(capabilities.submission.available, true);
        assert.equal(capabilities.inspection.available, true);
        assert.equal(capabilities.stop.available, true);
        return true;
      } catch (error) {
        if (error.code === "unavailable") return false;
        throw error;
      }
    }, "The native Hermes API did not become ready");
  } catch (error) {
    t.diagnostic(gatewayTail);
    throw error;
  }
  await assert.rejects(new HermesRuntime({ origin, apiKey: "invalid-fixture-key" }).capabilities(), { code: "unauthorized" });

  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
  shell = await startShell(directory);
  const firstPage = await browser.newPage();
  await firstPage.goto(shell.origin);
  await firstPage.getByRole("heading", { name: "Manager" }).waitFor();

  const session = { schemaVersion: 1, id: "session_fixture1", taskId: "task_fixture1" };
  const submit = `
    import { HermesRuntime } from "@praxis/hermes-runtime";
    const [origin, session, prompt] = process.argv.slice(1);
    const runtime = new HermesRuntime({ origin, apiKey: process.env.PRAXIS_FIXTURE_KEY });
    process.stdout.write(JSON.stringify(await runtime.createAssignment(JSON.parse(session), prompt)));
  `;
  const child = await execute(process.execPath, [
    "--input-type=module", "--eval", submit, origin, JSON.stringify(session), holdPrompt,
  ], { env: { ...process.env, PRAXIS_FIXTURE_KEY: apiKey }, timeout: 20_000 });
  const assignment = JSON.parse(child.stdout);
  await until(() => provider.holdCalls() > 0, "The native run did not invoke the loopback provider");
  const active = await waitForState(runtime, assignment, "running");
  assert.deepEqual(runtimeSessionSnapshotSchema.parse(active), active);
  assert.equal(active.output.availability, "unavailable");

  await firstPage.close();
  await stopProcess(shell.processHandle);
  shell = await startShell(directory);
  const secondPage = await browser.newPage();
  await secondPage.goto(shell.origin);
  await secondPage.getByRole("heading", { name: "Manager" }).waitFor();

  const reconnected = new HermesRuntime({ origin, apiKey });
  assert.equal((await reconnected.inspectAssignment(assignment)).status, "running");
  assert.equal((await reconnected.createAssignment(session, holdPrompt)).runId, assignment.runId);
  assert.equal(provider.holdCalls(), 1);
  assert.equal((await reconnected.stopAssignment(assignment)).status, "stopping");
  provider.release();
  await waitForState(reconnected, assignment, "stopped");

  const completedAssignment = await reconnected.createAssignment({
    schemaVersion: 1, id: "session_fixture2", taskId: "task_fixture2",
  }, "Complete the isolated Praxis fixture.");
  const completed = await waitForState(reconnected, completedAssignment, "completed");
  assert.deepEqual(completed.output, { availability: "available", text: finalOutput, truncated: false });
  t.diagnostic("Native bearer check, idempotent create, Praxis browser and UI host restart, exact stop and terminal output passed.");
});
