import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { defaultSettings, readSettings, saveSettings } from "@praxis/settings";
import { createSettingsServer } from "@praxis/settings/http";

const execute = promisify(execFile);
const settings = {
  schemaVersion: 1,
  policy: { axiomEnabled: false, profiles: ["engineering"] },
  manager: { runtime: "hermes", profile: "praxis-manager", model: "provider/manager-model" },
  worker: { runtime: "codex", model: "worker-model" },
  budgets: { maxTaskTokens: 20_000, maxTaskUsd: 2.5 },
  memory: { enabled: true },
  display: { autoPresent: false },
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "praxis-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "settings.json");
}

async function startEditor(t, path) {
  const server = createSettingsServer(path);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("config defaults are usable without writing a file", async (t) => {
  const path = await fixture(t);
  const defaults = await readSettings(path);
  assert.deepEqual(defaults, defaultSettings());
  assert.equal(defaults.schemaVersion, 1);
  assert.equal(defaults.manager.runtime, "hermes");
  assert.equal(defaults.policy.axiomEnabled, true);
  assert.equal(defaults.memory.enabled, true);
  assert.equal(defaults.display.autoPresent, true);
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("one readable config round-trips in a fresh process with separate settings toggles", async (t) => {
  const path = await fixture(t);
  assert.deepEqual(await saveSettings(path, settings), settings);
  const content = await readFile(path, "utf8");
  assert.ok(content.includes('\n  "schemaVersion"'));
  assert.deepEqual(JSON.parse(content), settings);

  const program = `
    import { readSettings } from "@praxis/settings";
    process.stdout.write(JSON.stringify(await readSettings(process.argv[1])));
  `;
  const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", program, path], { timeout: 15_000 });
  assert.deepEqual(JSON.parse(stdout), settings);

  const updated = {
    ...settings,
    policy: { ...settings.policy, axiomEnabled: true },
    memory: { enabled: false },
    display: { autoPresent: true },
  };
  await saveSettings(path, updated);
  assert.deepEqual(await readSettings(path), updated);
});

test("invalid values and secret fields are rejected without altering a saved config", async (t) => {
  const path = await fixture(t);
  await saveSettings(path, settings);
  await assert.rejects(
    saveSettings(path, { ...settings, budgets: { maxTaskTokens: -2, maxTaskUsd: 2.5 } }),
    { code: "invalid_settings", message: /budgets\.maxTaskTokens/ },
  );
  await assert.rejects(
    saveSettings(path, { ...settings, manager: { ...settings.manager, apiKey: "private-fixture-value" } }),
    (error) => error.code === "invalid_settings" && !error.message.includes("private-fixture-value"),
  );
  await assert.rejects(
    saveSettings(path, { ...settings, bypassHostPermissions: true }),
    { code: "invalid_settings" },
  );
  assert.deepEqual(await readSettings(path), settings);
  assert.doesNotMatch(await readFile(path, "utf8"), /apiKey|private-fixture-value|bypassHostPermissions/);

  await writeFile(path, "{not json");
  await assert.rejects(readSettings(path), { code: "invalid_settings", message: /valid JSON/ });
});

test("the documented settings editor serves real data and keeps its write boundary with Axiom disabled", async (t) => {
  const path = await fixture(t);
  const origin = await startEditor(t, path);
  const page = await fetch(`${origin}/settings`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form[^>]*id="settings"/);

  const endpoint = `${origin}/api/settings`;
  const get = async () => (await fetch(endpoint)).json();
  const put = (value, source) => fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: source },
    body: JSON.stringify(value),
  });
  assert.deepEqual(await get(), defaultSettings());
  const saved = await put(settings, origin);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), settings);

  const foreign = await put({ ...settings, memory: { enabled: false } }, "http://localhost:3128");
  assert.equal(foreign.status, 403);
  const invalid = await put({ ...settings, budgets: { maxTaskTokens: -1, maxTaskUsd: null } }, origin);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /budgets\.maxTaskTokens/);
  assert.deepEqual(await get(), settings);
});
