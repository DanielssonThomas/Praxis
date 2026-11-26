import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../scripts/install-hermes-worker.mjs", import.meta.url));
const linux = { skip: process.platform !== "linux" || process.arch !== "x64" };

test("the installer advertises the named Linux worker setup command", () => {
  const result = spawnSync(process.execPath, [installer, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--hermes-bin.*--hermes-home.*--profile/);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "praxis-worker-install-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const user = join(directory, "user");
  const original = join(user, ".hermes");
  const home = join(directory, "worker-root");
  const profile = "worker-one";
  const profileHome = join(home, "profiles", profile);
  const launcher = join(directory, "hermes");
  const settings = join(directory, "settings.json");
  await mkdir(original, { recursive: true });
  await writeFile(join(original, ".env"), "PRAXIS_MCP_TOKEN=synthetic-personal-sentinel\n");
  await writeFile(settings, JSON.stringify({
    schemaVersion: 1,
    policy: { axiomEnabled: false, profiles: [] },
    manager: { runtime: "hermes", profile: "praxis-manager", model: null },
    worker: { runtime: "codex", model: null },
    budgets: { maxTaskTokens: null, maxTaskUsd: null },
    memory: { enabled: true },
    display: { autoPresent: true },
  }));
  await writeFile(launcher, `#!${process.execPath}
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const home = process.env.HERMES_HOME;
const profile = argv[1];
if (argv[0] === "--version") {
  console.log("Hermes Agent v0.23.3");
} else if (argv[2] === "profile" && argv[3] === "create") {
  const destination = join(home, "profiles", argv[4]);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "SOUL.md"), "Stock Hermes personality.");
  writeFileSync(join(destination, "config.yaml"), "{}");
  writeFileSync(join(destination, "created-with.json"), JSON.stringify(argv.slice(5)));
} else if (argv[2] === "config" && argv[3] === "set") {
  const file = join(home, "profiles", profile, "config.yaml");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config[argv[4]] = JSON.parse(argv[5]);
  writeFileSync(file, JSON.stringify(config));
} else {
  process.exitCode = 2;
}
`, { mode: 0o700 });
  const run = (args = [], target = home) => spawnSync(process.execPath, [
    installer, "--hermes-bin", launcher, "--hermes-home", target, "--profile", profile, ...args,
  ], { env: { HOME: user, PATH: process.env.PATH, PRAXIS_CONFIG_FILE: settings }, encoding: "utf8", timeout: 15_000 });
  return { directory, home, original, profile, profileHome, run };
}

test("a worker installation configures only scoped Praxis tools and keeps credentials and owner settings local", linux, async (t) => {
  const { home, original, profile, profileHome, run } = await fixture(t);
  const setup = run();
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).profile, profile);
  assert.equal(JSON.parse(setup.stdout).home, home);
  const createdWith = JSON.parse(await readFile(join(profileHome, "created-with.json"), "utf8"));
  assert.deepEqual(createdWith.sort(), ["--no-alias", "--no-credentials", "--no-skills"]);
  await assert.rejects(access(join(profileHome, ".env")), { code: "ENOENT" });
  assert.equal(await readFile(join(original, ".env"), "utf8"), "PRAXIS_MCP_TOKEN=synthetic-personal-sentinel\n");

  const configPath = join(profileHome, "config.yaml");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.platform_toolsets, { cli: ["mcp-praxis"], api_server: ["mcp-praxis"] });
  assert.equal(config["gateway.standalone"], true);
  assert.equal(config["tools.tool_search.enabled"], false);
  assert.deepEqual(config["mcp_servers.praxis"], {
    url: "http://127.0.0.1:3211/mcp",
    headers: { Authorization: "Bearer ${PRAXIS_MCP_TOKEN}" },
    tools: { include: ["inspect_task", "inspect_worker", "report_worker", "propose_skill", "load_curated_skill"], prompts: false, resources: false },
  });
  const soul = join(profileHome, "SOUL.md");
  const seed = await readFile(soul, "utf8");
  assert.match(seed, /# Praxis worker/);
  assert.match(seed, /report_worker/);
  const ownerConfig = JSON.stringify({ ...config, model: { default: "owner-model" } });
  await writeFile(configPath, ownerConfig);
  await writeFile(soul, "Owner worker instructions.\n");
  await writeFile(join(profileHome, ".env"), "PRAXIS_MCP_TOKEN=synthetic-worker-sentinel\n");
  const reinstall = run();
  assert.equal(reinstall.status, 0, reinstall.stderr);
  assert.equal(await readFile(soul, "utf8"), "Owner worker instructions.\n");

  const replace = run(["--replace"]);
  assert.equal(replace.status, 0, replace.stderr);
  assert.equal(await readFile(soul, "utf8"), seed);
  assert.equal(await readFile(configPath, "utf8"), ownerConfig);
  assert.equal(await readFile(join(profileHome, ".env"), "utf8"), "PRAXIS_MCP_TOKEN=synthetic-worker-sentinel\n");
});

test("worker installation rejects nonlocal MCP and protects roots it does not own", linux, async (t) => {
  const { directory, home, original, run } = await fixture(t);
  const remote = run(["--mcp-origin", "http://example.invalid/mcp"]);
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /loopback HTTP endpoint/);
  await assert.rejects(access(home), { code: "ENOENT" });

  const personal = run([], original);
  assert.equal(personal.status, 1);
  assert.match(personal.stderr, /dedicated Hermes root/);

  const unowned = join(directory, "unowned");
  await mkdir(unowned);
  await writeFile(join(unowned, "config.yaml"), "unowned: true\n");
  const occupied = run([], unowned);
  assert.equal(occupied.status, 1);
  assert.match(occupied.stderr, /empty root/);
  assert.equal(await readFile(join(unowned, "config.yaml"), "utf8"), "unowned: true\n");

  const redirected = join(directory, "redirected-root");
  await symlink(unowned, redirected, "dir");
  const alias = run([], redirected);
  assert.equal(alias.status, 1);
  assert.match(alias.stderr, /real path/);
});
