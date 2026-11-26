import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { providerFixture, stopProcess, until } from "./hermes-fixture.mjs";

const run = promisify(execFile);
const installer = fileURLToPath(new URL("../../scripts/install-hermes-worker.mjs", import.meta.url));

export async function startInstalledHermesWorker(t, { profile, endpoint, mcpKey, respond, customize }) {
  const binary = process.env.PRAXIS_HERMES_BIN;
  const axiom = process.env.PRAXIS_AXIOM_ROOT;
  assert.ok(binary && axiom, "Set PRAXIS_HERMES_BIN and PRAXIS_AXIOM_ROOT to the pinned source builds.");
  const directory = await mkdtemp(join(tmpdir(), "praxis-installed-worker-"));
  const user = join(directory, "user");
  const home = join(directory, "hermes");
  const profileHome = join(home, "profiles", profile);
  const env = { HOME: user, PATH: process.env.PATH, HERMES_HOME: home,
    HERMES_DISABLE_LAZY_INSTALLS: "1", HERMES_NO_SYSTEMD: "1", TERM: "dumb" };

  let gateway;
  let provider;
  t.after(async () => {
    await stopProcess(gateway);
    await provider?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  await mkdir(user);
  const setup = await run(process.execPath, [installer, "--hermes-bin", binary, "--hermes-home", home,
    "--profile", profile, "--axiom-root", axiom, "--mcp-origin", endpoint], { env, timeout: 45_000 });
  const installed = JSON.parse(setup.stdout);
  assert.equal(installed.profile, profile);
  assert.equal(installed.policy.status, "enabled");
  await customize?.(profileHome);

  provider = await providerFixture(respond);
  const apiKey = randomBytes(32).toString("base64url");
  await writeFile(join(profileHome, ".env"), `API_SERVER_KEY=${apiKey}\nPRAXIS_MCP_TOKEN=${mcpKey}\n`, { mode: 0o600 });
  await appendFile(join(profileHome, "config.yaml"), ["", "model:", "  provider: custom",
    `  base_url: ${provider.origin}`, "  default: fake-model", "  api_key: fixture-only", "  context_length: 128000", ""].join("\n"));
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  gateway = spawn(binary, ["-p", profile, "gateway", "run"], { cwd: directory, stdio: "ignore", env: {
    ...env, API_SERVER_ENABLED: "true", API_SERVER_HOST: "127.0.0.1", API_SERVER_PORT: String(port),
  } });
  const origin = `http://127.0.0.1:${port}/p/${profile}`;
  const runtime = new HermesRuntime({ origin, apiKey });
  await until(async () => {
    assert.equal(gateway.exitCode, null, "The installed worker exited while starting.");
    try { return (await runtime.capabilities()).submission.available; }
    catch (error) { if (error.code === "unavailable") return false; throw error; }
  }, "The installed worker did not open its named native route.");
  return { home, origin, apiKey, runtime };
}
