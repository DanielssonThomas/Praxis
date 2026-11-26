import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { enter, eventually, startDesktop } from "./desktop-fixture.mjs";
import { providerFixture, stopProcess, until } from "./hermes-fixture.mjs";

const run = promisify(execFile);
const credential = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const executable = "/usr/bin/praxis-desktop";
const host = "/usr/lib/Praxis/host";
const title = "#setup-step-heading";
const apiKey = credential();
const operator = credential();
const request = "Inspect the default policy fixture.";
const reply = "The installed default manager answered.";

function observedPolicy(prompt) {
  return [...prompt.matchAll(/## Plugin Context: axiom\.policy-\d{3}\n<!-- hermes-plugin-section-chars:(\d+) -->\n\n/g)]
    .map(({ 0: header, 1: length, index }) =>
      Array.from(prompt.slice(index + header.length)).slice(0, Number(length)).join(""))
    .join("\n\n");
}

async function command(desktop, input) {
  const element = await desktop.element('[aria-label="Command"]');
  await element.click();
  await element.clear();
  await element.type(input + enter);
}

test("fresh installed Setup opens the default manager and its pinned policy runs", { timeout: 120_000 }, async (t) => {
  const { PRAXIS_HERMES_BIN: hermes, PRAXIS_AXIOM_ROOT: axiom } = process.env;
  assert.ok([hermes, axiom].every((path) => path && isAbsolute(path)),
    "Set absolute paths to the pinned Hermes and extracted Axiom runtime.");
  assert.equal(process.platform + "-" + process.arch, "linux-x64");
  await access(join(host, "setup/install-hermes-manager.mjs"));
  const directory = await mkdtemp(join(tmpdir(), "praxis-release-first-run-"));
  let desktop;
  let gateway;
  let provider;
  t.after(async () => {
    await desktop?.close();
    await stopProcess(gateway);
    await provider?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const home = join(directory, "user");
  await mkdir(home, { mode: 0o700 });
  const environment = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share") };
  const settings = join(environment.XDG_CONFIG_HOME, "praxis/settings.json");
  await assert.rejects(access(settings), { code: "ENOENT" });
  desktop = await startDesktop(executable, { environment });
  assert.equal((await desktop.handles()).length, 1);
  assert.deepEqual(await desktop.execute("return [location.protocol, location.host]"), ["tauri:", "localhost"]);
  await desktop.waitForText("h1", "Manager");
  await command(desktop, "/setup");
  await desktop.waitForText("h1", "Setup");
  await desktop.waitForText("#setup-host-status", /Local Praxis host ready/);
  await desktop.waitForText("#setup-host-status span", "Node.js 24.22.3");
  await (await desktop.element("praxis-setup footer button.primary")).click();
  await desktop.waitForText(title, "Connect a named Hermes profile");
  await (await desktop.element("praxis-setup summary")).click();
  await desktop.waitForText("praxis-setup details pre", /\/usr\/lib\/Praxis\/host\/setup\/install-hermes-manager\.mjs/);
  await desktop.waitForText("praxis-setup details a", "Axiom v1.0.0");
  await (await desktop.element("praxis-setup footer button.primary")).click();
  await desktop.waitForText(title, "Open Manager with your operator token");
  assert.equal(await desktop.execute("return document.querySelectorAll('praxis-setup input').length"), 0);
  await desktop.close();
  desktop = undefined;

  const hermesHome = join(directory, "hermes");
  const mcpToken = credential();
  const authority = join(directory, "authority.json");
  const nativeEnvironment = { ...environment, PATH: process.env.PATH };
  const { stdout } = await run(join(host, "bin/node"), [
    join(host, "setup/install-hermes-manager.mjs"), "--hermes-bin", hermes, "--hermes-home", hermesHome, "--axiom-root", axiom,
  ], { env: nativeEnvironment, timeout: 40_000 });
  const setup = JSON.parse(stdout);
  const profile = "praxis-manager";
  assert.equal(setup.profile, profile);
  assert.equal(setup.policy.status, "enabled");
  assert.equal(setup.policy.digest, "sha256:2e968204a73b3d6384af8ff0687c8126c3ef798725f4d566ccbf655151ebcc78");
  const profileHome = join(hermesHome, "profiles", profile);
  const manifest = JSON.parse(await readFile(join(profileHome, "plugins/axiom/axiom-bundle.json"), "utf8"));
  assert.equal(manifest.digest, "sha256:59724db639fe977f032157fbaa3ee45b883a18bc152b6d0bc5e3b7ab9a337c9d");
  const profileCredentials = join(profileHome, ".env");
  const profileConfig = join(profileHome, "config.yaml");
  await assert.rejects(access(join(profileHome, "auth.json")), { code: "ENOENT" });
  assert.match(await readFile(profileConfig, "utf8"), /\$\{PRAXIS_MCP_TOKEN\}/);
  await appendFile(profileCredentials, "\nAPI_SERVER_KEY=" + apiKey + "\nPRAXIS_MCP_TOKEN=" + mcpToken + "\n", { mode: 0o600 });
  assert.equal((await stat(profileCredentials)).mode & 0o077, 0);
  await writeFile(authority, JSON.stringify({
    schemaVersion: 1, database: join(directory, "state.sqlite"),
    grants: [{ principalId: "principal_release", tokenDigest: digest(mcpToken), taskIds: [], sessions: [], actionKinds: [] }],
  }), { mode: 0o600 });

  const core = (await readFile(join(axiom, "core/AXIOMS.md"), "utf8")).trim();
  const skills = ["context", "delegate", "design", "diagnose", "knowledge", "verify"];
  let loaded = false;
  provider = await providerFixture((call) => {
    if (call.messages.findLast(({ role }) => role === "user")?.content === request) {
      const prompt = call.messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n");
      loaded ||= observedPolicy(prompt) === "Axiom policy digest " + setup.policy.digest + "\n\n" + core
        && skills.every((name) => prompt.includes("axiom:" + name));
    }
    return { message: { role: "assistant", content: reply } };
  });
  await appendFile(profileConfig, [
    "", "model:", "  provider: custom", "  base_url: " + provider.origin, "  default: fake-model",
    "  api_key: fixture-only", "  context_length: 128000",
    "kanban:", "  dispatch_in_gateway: false", "",
  ].join("\n"));

  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  const origin = "http://127.0.0.1:" + port + "/p/" + profile;
  gateway = spawn(hermes, ["-p", "default", "gateway", "run"], {
    env: {
      ...nativeEnvironment, HERMES_HOME: hermesHome, HERMES_NO_SYSTEMD: "1", HERMES_DISABLE_LAZY_INSTALLS: "1",
      API_SERVER_ENABLED: "true", API_SERVER_HOST: "127.0.0.1", API_SERVER_PORT: String(port), API_SERVER_KEY: credential(),
    },
    stdio: "ignore",
  });
  const adapter = new HermesRuntime({ origin, apiKey });
  await until(async () => {
    assert.equal(gateway.exitCode, null);
    try {
      return (await adapter.capabilities()).submission.available;
    } catch (error) {
      if (error.code === "unavailable") return false;
      throw error;
    }
  }, "The default named Hermes profile did not open.");
  desktop = await startDesktop(executable, { environment: {
    ...environment, PRAXIS_MCP_CONFIG_FILE: authority, PRAXIS_HERMES_ORIGIN: origin,
    PRAXIS_HERMES_API_KEY: apiKey, PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator),
    PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID: "principal_release",
  } });
  await desktop.waitForText("h1", "Manager");
  const input = 'form[aria-label="Open Manager"] input[type="password"]';
  await (await desktop.element(input)).type("refused-fixture-operator" + enter);
  await desktop.waitForText("praxis-manager [role=status]", /operator token was refused/i);
  await (await desktop.element(input)).clear();
  await (await desktop.element(input)).type(operator + enter);
  await desktop.waitForText("#manager-lock", "Lock manager");
  await command(desktop, request);
  await eventually(() => desktop.execute(
    "return Array.from(document.querySelectorAll('[role=log] li')).some(node => node.textContent.includes(arguments[0]))",
    reply,
  ), "The default named manager did not answer in the installed application.");
  assert.equal(loaded, true, "The native request must carry the exact pinned Axiom core and six skills.");
  await assert.rejects(access(settings), { code: "ENOENT" });
  t.diagnostic("Confirmed the installed Setup, default praxis-manager profile, local credential access modes, refused and accepted operator unlock, live Hermes turn, and exact pinned Axiom core and six skills in its loopback request.");
});
