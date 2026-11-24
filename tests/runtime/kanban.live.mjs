import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { OperationalStore } from "@praxis/state";
import { chromium } from "playwright";
import { startShell, stopProcess } from "./hermes-fixture.mjs";

const execute = promisify(execFile);
const title = "Native Hermes board fixture";

test("the browser reflects native Hermes transitions and stores one verified GitHub issue link", { timeout: 120_000 }, async (t) => {
  const executable = process.env.PRAXIS_HERMES_BIN;
  assert.ok(executable, "Set PRAXIS_HERMES_BIN to the installed Hermes CLI");
  const directory = await mkdtemp(join(tmpdir(), "praxis-native-board-"));
  const home = join(directory, ".hermes");
  const database = join(directory, "state.sqlite");
  await mkdir(home);
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    HERMES_HOME: home,
    HERMES_DISABLE_LAZY_INSTALLS: "1",
    HERMES_NO_SYSTEMD: "1",
    TERM: "dumb",
  };
  const cli = (...args) => execute(executable, ["kanban", "--board", "default", ...args], { env, timeout: 15_000 });
  const version = await execute(executable, ["--version"], { env, timeout: 10_000 });
  t.diagnostic(version.stdout.split("\n").filter((line) => /^(Hermes Agent|Python:)/.test(line)).join("\n"));
  await cli("init");
  const native = JSON.parse((await cli("create", title, "--assignee", "default", "--json")).stdout);
  assert.equal(native.status, "ready");

  const operator = randomBytes(32).toString("base64url");
  const providerKey = randomBytes(32).toString("base64url");
  const providerCalls = [];
  const provider = createServer((request, response) => {
    providerCalls.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    if (request.method !== "GET" || request.url !== "/repos/fixture/project/issues/42"
      || request.headers.authorization !== `Bearer ${providerKey}`) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      number: 42, html_url: "https://github.com/fixture/project/issues/42",
    }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");

  let shell;
  let browser;
  t.after(async () => {
    await browser?.close();
    await stopProcess(shell?.processHandle);
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  shell = await startShell(directory, {
    HOME: directory,
    PRAXIS_KANBAN_HERMES_BIN: executable,
    PRAXIS_KANBAN_HERMES_HOME: home,
    PRAXIS_KANBAN_DATABASE: database,
    PRAXIS_OPERATOR_TOKEN_DIGEST: createHash("sha256").update(operator).digest("hex"),
    PRAXIS_GITHUB_TOKEN: providerKey,
    PRAXIS_GITHUB_API_ORIGIN: `http://127.0.0.1:${provider.address().port}`,
  });
  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1000, height: 780 } });
  page.setDefaultTimeout(6_000);
  await page.goto(shell.origin);
  const command = page.getByRole("textbox", { name: "Command", exact: true });
  await command.fill("/k");
  await command.press("Enter");
  await page.getByRole("heading", { name: "Kanban", exact: true }).waitFor();
  const open = page.getByRole("form", { name: "Open Kanban" });
  await open.getByLabel("Operator token").fill(operator);
  await open.getByRole("button", { name: "Open board" }).click();

  const at = (status) => page.locator(`.kanban-column[data-status="${status}"]`)
    .locator(`[data-native-id="${native.id}"]`);
  await at("ready").getByRole("heading", { name: title }).waitFor();
  const request = { nativeId: native.id, repository: "fixture/project", number: 42 };
  const api = new URL("api/kanban/link", shell.origin);
  const origin = new URL(shell.origin).origin;
  const post = (credential, source) => fetch(api, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, Origin: source, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  assert.equal((await post("invalid-credential-for-board-fixture", origin)).status, 401);
  assert.equal((await post(operator, "http://localhost:3299")).status, 403);
  assert.deepEqual(providerCalls, []);

  await at("ready").getByRole("textbox", { name: "GitHub issue", exact: true }).fill("fixture/project#42");
  await at("ready").getByRole("button", { name: "Link issue" }).click();
  const linked = at("ready").getByRole("link", { name: "fixture/project#42" });
  await linked.waitFor();
  assert.equal(await linked.getAttribute("href"), "https://github.com/fixture/project/issues/42");
  assert.equal((await post(operator, origin)).status, 200);
  assert.deepEqual(providerCalls, [{
    method: "GET", path: "/repos/fixture/project/issues/42", authorization: `Bearer ${providerKey}`,
  }]);

  await cli("block", native.id, "Isolated fixture transition");
  await page.getByRole("button", { name: "Refresh board" }).click();
  await at("blocked").getByRole("link", { name: "fixture/project#42" }).waitFor();
  await cli("unblock", native.id);
  await page.getByRole("button", { name: "Refresh board" }).click();
  await linked.waitFor();

  const reopened = new OperationalStore(database);
  try {
    const [saved] = reopened.eventsOfKind("task.issue_linked");
    assert.deepEqual(saved.details.issue, { provider: "github", repository: "fixture/project", number: 42 });
    assert.equal(reopened.eventsOfKind("task.issue_linked").length, 1);
  } finally {
    reopened.close();
  }
  t.diagnostic("Native ready → blocked → ready, operator scope, authorized provider verification and durable link replay passed.");
});
