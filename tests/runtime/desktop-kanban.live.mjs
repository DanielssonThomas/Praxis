import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { OperationalStore } from "@praxis/state";
import { enter, startDesktop, tab } from "./desktop-fixture.mjs";

const execute = promisify(execFile);
const title = "Native Hermes board desktop fixture";
const boardStatus = "#kanban-status";

async function command(desktop, value) {
  const control = await desktop.element('input[aria-label="Command"]');
  await control.click();
  await control.clear();
  await control.type(value + enter);
}

async function unlockBoard(desktop, token) {
  const input = await desktop.element('form[aria-label="Open Kanban"] input[type="password"]');
  await input.type(token + enter);
}

async function linkByKeyboard(desktop, task, issue) {
  const input = await desktop.element(task + ' input[placeholder="owner/repo#42"]');
  await input.click();
  await input.clear();
  await input.type(issue + tab);
  assert.equal(await desktop.execute("return document.activeElement.textContent.trim()"), "Link issue");
  await (await desktop.element(task + ' button[type="submit"]')).type(enter);
}

test("the packaged Kanban follows live native states and saves one scoped GitHub issue", { timeout: 120_000 }, async (t) => {
  const executable = process.env.PRAXIS_HERMES_BIN;
  const packagePath = process.env.PRAXIS_DESKTOP_DEB;
  assert.ok(executable && packagePath && isAbsolute(packagePath),
    "Set PRAXIS_HERMES_BIN and absolute PRAXIS_DESKTOP_DEB.");
  const directory = await mkdtemp(join(tmpdir(), "praxis-native-kanban-"));
  const home = join(directory, ".hermes");
  const database = join(directory, "state.sqlite");
  const bin = join(directory, "bin");
  const installed = join(directory, "installed");
  const binary = join(installed, "usr/bin/praxis-desktop");
  const operator = randomBytes(32).toString("base64url");
  const providerKey = randomBytes(32).toString("base64url");
  const providerCalls = [];
  const env = {
    PATH: process.env.PATH, HOME: directory, HERMES_HOME: home,
    HERMES_DISABLE_LAZY_INSTALLS: "1", HERMES_NO_SYSTEMD: "1", TERM: "dumb",
  };
  const provider = createServer((request, response) => {
    const authorized = request.headers.authorization === "Bearer " + providerKey;
    providerCalls.push({ path: request.url, method: request.method, authorized });
    if (!authorized || request.method !== "GET" || request.url !== "/repos/fixture/project/issues/42") {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      number: 42, html_url: "https://github.com/fixture/project/issues/42",
    }));
  });
  let desktop;
  t.after(async () => {
    try {
      await desktop?.close();
    } finally {
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  execFileSync("dpkg-deb", ["--extract", packagePath, installed], { timeout: 20_000 });
  await mkdir(home);
  await mkdir(bin);
  await writeFile(join(bin, "gio"), [
    "#!/bin/sh",
    '[ "$1" = open ] && [ "$#" = 2 ] || exit 2',
    '[ -z "$PRAXIS_GITHUB_TOKEN" ] || exit 3',
    'printf "%s\\n" "$2" > "$HOME/opened-issue.txt"',
    "",
  ].join("\n"), { mode: 0o700 });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");

  const cli = (...args) => execute(executable, ["kanban", "--board", "default", ...args], { env, timeout: 15_000 });
  const version = await execute(executable, ["--version"], { env, timeout: 10_000 });
  t.diagnostic(version.stdout.split("\n").filter((line) => /^(Hermes Agent|Python:)/.test(line)).join("\n"));
  await cli("init");
  const { id, status } = JSON.parse((await cli("create", title, "--assignee", "default", "--json")).stdout);
  assert.equal(status, "ready");
  assert.match(id, /^t_[a-f0-9]+$/);

  const desktopEnv = {
    ...env,
    PATH: bin + ":" + env.PATH,
    XDG_CACHE_HOME: join(directory, ".cache"),
    XDG_CONFIG_HOME: join(directory, ".config"),
    XDG_DATA_HOME: join(directory, ".local", "share"),
    PRAXIS_CONFIG_FILE: join(directory, "settings.json"),
  };
  const boardEnv = {
    ...desktopEnv,
    PRAXIS_KANBAN_HERMES_BIN: executable,
    PRAXIS_KANBAN_HERMES_HOME: home,
    PRAXIS_KANBAN_DATABASE: database,
    PRAXIS_OPERATOR_TOKEN_DIGEST: createHash("sha256").update(operator).digest("hex"),
  };
  desktop = await startDesktop(binary, { environment: {
    ...boardEnv,
    PRAXIS_GITHUB_TOKEN: providerKey,
    PRAXIS_GITHUB_API_ORIGIN: "http://127.0.0.1:" + provider.address().port,
  } });
  assert.equal((await desktop.handles()).length, 1);
  assert.equal(await desktop.execute("return location.protocol"), "tauri:");
  const wry = desktop.capabilities.browserVersion;
  await desktop.resize(390, 700);
  await command(desktop, "/k");
  await desktop.waitForText("h1", "Kanban");
  await unlockBoard(desktop, "invalid-operator-proof-01234567890123");
  await desktop.waitForText(boardStatus, /operator credential is required/i);
  assert.deepEqual(providerCalls, []);
  await unlockBoard(desktop, operator);

  const card = (nativeStatus) => '[data-status="' + nativeStatus + '"] [data-native-id="' + id + '"]';
  const issue = (nativeStatus) => card(nativeStatus) + ' [aria-label="Open fixture/project#42 in the browser"]';
  await desktop.waitForText(card("ready") + " h3", title);
  assert.equal(await desktop.execute("return window.innerWidth"), 390);
  assert.equal(await desktop.execute("return getComputedStyle(document.querySelector('praxis-kanban-board .board')).display"),
    "grid", "the packaged WebView must apply Angular component styles");
  assert.equal(await desktop.execute("return getComputedStyle(document.querySelector('praxis-shell')).display"),
    "grid", "the packaged shell must retain its grid layout");
  assert.equal(await desktop.execute("return document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth"), true);
  await linkByKeyboard(desktop, card("ready"), "invalid-input");
  await desktop.waitForText(boardStatus, /owner\/repo#42/i);
  assert.deepEqual(providerCalls, []);
  await linkByKeyboard(desktop, card("ready"), "fixture/project#43");
  await desktop.waitForText(boardStatus, /not authorize/i);
  await linkByKeyboard(desktop, card("ready"), "fixture/project#42");
  await desktop.waitForText(issue("ready"), "fixture/project#42");
  await linkByKeyboard(desktop, card("ready"), "fixture/project#42");
  await desktop.waitForText(boardStatus, "GitHub issue linked.");

  await (await desktop.element(issue("ready"))).type(enter);
  await desktop.waitForText(boardStatus, "GitHub issue opened in the browser.");
  assert.equal((await readFile(join(directory, "opened-issue.txt"), "utf8")).trim(),
    "https://github.com/fixture/project/issues/42");
  assert.equal((await desktop.handles()).length, 1);

  await cli("block", id, "Isolated fixture transition");
  await (await desktop.element("#kanban-refresh")).click();
  await desktop.waitForText(issue("blocked"), "fixture/project#42");
  await cli("unblock", id);
  await (await desktop.element("#kanban-refresh")).click();
  await desktop.waitForText(issue("ready"), "fixture/project#42");
  assert.deepEqual(providerCalls, [
    { path: "/repos/fixture/project/issues/43", method: "GET", authorized: true },
    { path: "/repos/fixture/project/issues/42", method: "GET", authorized: true },
  ]);
  const store = new OperationalStore(database);
  try {
    const rows = store.eventsOfKind("task.issue_linked");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].details.issue, { provider: "github", repository: "fixture/project", number: 42 });
  } finally {
    store.close();
  }
  const evidence = process.env.PRAXIS_DESKTOP_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await desktop.screenshot(join(evidence, "kanban-390x700.png"));
  }

  await desktop.close();
  desktop = await startDesktop(binary, { environment: boardEnv });
  await command(desktop, "/kanban");
  await unlockBoard(desktop, operator);
  await desktop.waitForText("#kanban-provider", /GitHub issue linking is unavailable/);
  await desktop.waitForText(issue("ready"), "fixture/project#42");
  assert.equal(await desktop.execute("return document.querySelectorAll('[data-native-id] form').length"), 0);
  await desktop.close();
  desktop = await startDesktop(binary, { environment: desktopEnv });
  await command(desktop, "/kanban");
  await desktop.waitForText(boardStatus, /Configure the local Hermes board/);
  const webkit = execFileSync("pkg-config", ["--modversion", "webkit2gtk-4.1"], { encoding: "utf8" }).trim();
  t.diagnostic("Linux x64 Wry " + wry + " / WebKitGTK " + webkit
    + ". Keyboard issue linking, provider and operator denial, exact durable retry, native board transitions,"
    + " verified opener isolation, and missing setup/provider states passed.");
});
