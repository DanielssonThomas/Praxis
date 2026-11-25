import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { HermesRuntime } from "@praxis/hermes-runtime";

const execute = promisify(execFile);

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

export async function stopProcess(process) {
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

export async function until(observe, description, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await observe();
    if (result) return result;
    await delay(150);
  }
  assert.fail(description);
}

export async function providerFixture(respond) {
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
    const { message, finishReason = "stop", holdAfterMessage } = await respond(call);

    const base = { id: "chatcmpl-praxis-fixture", created: 1, model: "fake-model" };
    const usage = { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 };
    if (call.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (choices, extra = {}) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices, ...extra })}\n\n`;
      const { tool_calls, ...fields } = message;
      const delta = tool_calls === undefined ? fields : {
        ...fields,
        tool_calls: tool_calls.map((tool, index) => ({ ...tool, index })),
      };
      response.write(frame([{ index: 0, delta, finish_reason: null }]));
      await holdAfterMessage;
      response.write(frame([{ index: 0, delta: {}, finish_reason: finishReason }]));
      response.write(frame([], { usage }));
      response.end("data: [DONE]\n\n");
    } else {
      await holdAfterMessage;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage,
      }));
    }
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}/v1`, close: () => closeServer(server) };
}

export async function startHermesFixture(t, respond, configLines = []) {
  const executable = process.env.PRAXIS_HERMES_BIN;
  assert.ok(executable, "Set PRAXIS_HERMES_BIN to an installed Hermes executable with the messaging extra");

  const directory = await mkdtemp(join(tmpdir(), "praxis-hermes-live-"));
  const provider = await providerFixture(respond);
  let gateway;
  t.after(async () => {
    await stopProcess(gateway);
    await provider.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
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
    ...configLines,
    "",
  ].join("\n"));

  const apiKey = randomUUID();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    HERMES_HOME: hermesHome,
    HERMES_DISABLE_LAZY_INSTALLS: "1",
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
  return { origin, apiKey, runtime, directory };
}

export async function startShell(directory, environment = {}) {
  const processHandle = spawn(process.execPath, ["packages/shell/dist/cli.js"], {
    env: { ...process.env, PRAXIS_PORT: "0", PRAXIS_CONFIG_FILE: join(directory, "settings.json"), ...environment },
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
