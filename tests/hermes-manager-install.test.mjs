import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings } from "@praxis/settings";

test("manager installation rejects a nonlocal MCP endpoint before touching the profile root", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-manager-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "hermes");
  const result = spawnSync(process.execPath, [
    "scripts/install-hermes-manager.mjs", "--hermes-bin", join(directory, "hermes-bin"),
    "--hermes-home", home, "--axiom-root", join(directory, "axiom"),
    "--mcp-origin", "http://example.invalid/mcp",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Praxis MCP must use a loopback HTTP endpoint/);
  await assert.rejects(access(home), { code: "ENOENT" });
});


test("a partially seeded profile cannot pass as a completed manager on retry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-manager-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "dedicated");
  const userHome = join(directory, "user");
  const launcher = join(directory, "hermes");
  const settings = join(directory, "settings.json");
  await mkdir(userHome);
  await writeFile(settings, JSON.stringify({ ...defaultSettings(), policy: { axiomEnabled: false, profiles: [] } }));
  await writeFile(launcher, `#!/usr/bin/env node
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
if (process.argv[2] === "--version") console.log("Hermes Agent v0.23.3");
else if (process.argv[2] === "profile") {
  mkdirSync(join(process.env.HERMES_HOME, "profiles", process.argv[4], "SOUL.md"), { recursive: true });
} else process.exitCode = 2;
`, { mode: 0o700 });
  const run = () => spawnSync(process.execPath, [
    "scripts/install-hermes-manager.mjs", "--hermes-bin", launcher, "--hermes-home", home,
  ], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: userHome, PRAXIS_CONFIG_FILE: settings } });
  const first = run();
  assert.equal(first.status, 1);
  assert.match(first.stderr, /could not create and seed/);

  const stock = join(home, "profiles", "praxis-manager", "SOUL.md");
  await rm(stock, { recursive: true });
  await writeFile(stock, "The generic Hermes personality.");
  const retry = run();
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /lacks a completed Praxis manager seed/);
});
