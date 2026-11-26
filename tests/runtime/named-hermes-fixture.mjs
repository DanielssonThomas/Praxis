import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { providerFixture, stopProcess, until } from "./hermes-fixture.mjs";

const run = promisify(execFile);
const pinned = "caafe5389ae585ef77387a962aee05b1bcf17029";

export async function startNamedHermesFixture(t, profile, respond) {
  const executable = process.env.PRAXIS_HERMES_BIN;
  assert.ok(executable, "Set PRAXIS_HERMES_BIN to the pinned Hermes source installation.");
  const home = await mkdtemp(join(tmpdir(), "praxis-named-fixture-"));
  let gateway;
  let provider;
  t.after(async () => {
    await stopProcess(gateway);
    await provider?.close();
    await rm(home, { recursive: true, force: true });
  });
  const env = {
    PATH: process.env.PATH, HOME: home, HERMES_HOME: join(home, ".hermes"),
    HERMES_DISABLE_LAZY_INSTALLS: "1", HERMES_NO_SYSTEMD: "1", TERM: "dumb",
  };
  const version = await run(executable, ["--version"], { env, timeout: 10_000 });
  assert.match(version.stdout, /Hermes Agent v0\.23\.3\b/);
  const source = /^Install directory:\s*(.+)$/m.exec(version.stdout)?.[1];
  assert.ok(source, "The fixture needs the pinned Hermes Git source.");
  assert.equal((await run("git", ["-C", source, "rev-parse", "HEAD"], { env })).stdout.trim(), pinned);
  t.diagnostic(version.stdout.split("\n").filter((line) => /^(Hermes Agent|Python:|OpenAI SDK:)/.test(line)).join("\n"));

  await mkdir(env.HERMES_HOME, { recursive: true });
  await writeFile(join(env.HERMES_HOME, "config.yaml"), [
    "gateway:", "  multiplex_profiles: true", "updates:", "  check: false",
    "kanban:", "  dispatch_in_gateway: false", "",
  ].join("\n"));
  await run(executable, ["profile", "create", profile, "--no-credentials", "--no-alias", "--no-skills"], {
    env, timeout: 25_000,
  });
  const profileHome = join(env.HERMES_HOME, "profiles", profile);
  const apiKey = randomUUID();
  provider = await providerFixture(respond);
  await writeFile(join(profileHome, ".env"), `API_SERVER_KEY=${apiKey}\n`, { mode: 0o600 });
  await writeFile(join(profileHome, "config.yaml"), [
    "model:", "  provider: custom", `  base_url: "${provider.origin}"`, "  default: fake-model",
    "  api_key: fixture-only", "  context_length: 128000", "tools:", "  connectors:", "    enabled: false",
    "kanban:", "  dispatch_in_gateway: false", "",
  ].join("\n"), { mode: 0o600 });

  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  gateway = spawn(executable, ["gateway", "run"], {
    env: {
      ...env, API_SERVER_ENABLED: "true", API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: String(port), API_SERVER_KEY: randomUUID(),
    },
    stdio: "ignore",
  });
  const origin = `http://127.0.0.1:${port}/p/${profile}`;
  const runtime = new HermesRuntime({ origin, apiKey });
  await until(async () => {
    assert.equal(gateway.exitCode, null, "The named gateway exited during startup.");
    try {
      return (await runtime.capabilities()).submission.available;
    } catch (error) {
      if (error.code === "unavailable") return false;
      throw error;
    }
  }, "The authenticated named Hermes profile did not start.");
  return { origin, apiKey, runtime };
}
