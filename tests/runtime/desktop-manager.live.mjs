import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { defaultSettings, updateSettings } from "@praxis/settings";
import { OperationalStore } from "@praxis/state";
import { enter, eventually, startDesktop } from "./desktop-fixture.mjs";
import { until } from "./hermes-fixture.mjs";
import { startNamedHermesFixture } from "./named-hermes-fixture.mjs";

const longTail = "Bounded output from an earlier native worker.";
const workerText = "The independent native worker is still running.";
const reply = "The named manager identified the scoped task.";
const firstPrompt = "Show the scoped work.";
const secondPrompt = "Respect the saved presentation preference.";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const profile = "praxis-desktop-fixture-manager";

test("packaged Manager reconnects real named Hermes output and Overview restores real workers", {
  timeout: 120_000,
}, async (t) => {
  const packagePath = process.env.PRAXIS_DESKTOP_DEB;
  assert.ok(packagePath && isAbsolute(packagePath), "Set PRAXIS_DESKTOP_DEB to the packaged desktop artifact.");
  const directory = await mkdtemp(join(tmpdir(), "praxis-desktop-manager-"));
  let desktop;
  let releaseWorker;
  let releaseManager;
  const workerHold = new Promise((resolve) => { releaseWorker = resolve; });
  const managerHold = new Promise((resolve) => { releaseManager = resolve; });
  const store = new OperationalStore(join(directory, "state.sqlite"));
  t.after(async () => {
    releaseWorker();
    releaseManager();
    await desktop?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const installed = join(directory, "installed");
  execFileSync("dpkg-deb", ["--extract", packagePath, installed]);
  const binary = join(installed, "usr/bin/praxis-desktop");
  const task = (key, title) => ({ schemaVersion: 1, id: `task_${key}`, title });
  const workers = [
    task("desktop_worker", "Desktop fixture worker"),
    task("desktop_completed", "Completed fixture worker"),
  ].map((task) => ({
    task,
    session: { schemaVersion: 1, taskId: task.id, id: task.id.replace("task_", "session_") },
  }));
  const foreign = task("outside_grant", "Private fixture task outside the manager grant");
  store.recordTask(foreign);
  for (const { task, session } of workers) {
    store.recordTask(task);
    store.recordSession(session);
  }
  const footer = [
    `[[praxis:task:${workers[0].task.id}]]`, `[[praxis:session:${workers[0].session.id}]]`,
    `[[praxis:task:${foreign.id}]]`, "[[praxis:task:task_missing_fixture]]",
  ].join("\n");
  let managerCalls = 0;
  const { runtime, origin, apiKey } = await startNamedHermesFixture(t, profile, (call) => {
    if (!call.tools?.length) return { message: { role: "assistant", content: "Fixture title" } };
    const prompt = call.messages.findLast(({ role }) => role === "user")?.content;
    if (prompt === workers[0].task.title) {
      return { message: { role: "assistant", content: workerText }, holdAfterMessage: workerHold };
    }
    if (prompt === workers[1].task.title) {
      const lines = Array.from({ length: 500 }, (_, index) => `Native fixture output line ${index} with its own sequence.\n`);
      return { message: { role: "assistant", content: lines.join("") + longTail } };
    }
    if (prompt === firstPrompt) {
      managerCalls++;
      return { message: { role: "assistant", content: `${reply}\n\n${footer}` }, holdAfterMessage: managerHold };
    }
    return { message: { role: "assistant", content: `Presentation preference observed.\n\n${footer}` } };
  });
  const completed = await runtime.createAssignment(workers[1].session, workers[1].task.title);
  await until(async () => {
    const { status } = await runtime.inspectAssignment(completed);
    assert.ok(!["failed", "interrupted", "stopped", "unknown"].includes(status), `Fixture worker reported ${status}.`);
    return status === "completed";
  }, "Completed worker never settled.");
  const active = await runtime.createAssignment(workers[0].session, workers[0].task.title);
  const assignments = [active, completed];
  await until(async () => (await runtime.inspectAssignment(active)).status === "running", "Active worker never started.");

  const principalId = "principal_desktop_manager";
  const authority = join(directory, "authority.json");
  const settings = join(directory, "settings.json");
  const operator = randomBytes(32).toString("base64url");
  await writeFile(settings, JSON.stringify({
    ...defaultSettings(), manager: { ...defaultSettings().manager, profile },
  }), { mode: 0o600 });
  await writeFile(authority, JSON.stringify({
    schemaVersion: 1, database: join(directory, "state.sqlite"),
    grants: [{
      principalId, tokenDigest: digest(randomBytes(32).toString("base64url")),
      taskIds: workers.map(({ task }) => task.id),
      sessions: workers.map(({ session }, index) => ({
        sessionId: session.id, assignment: assignments[index], canReport: false,
      })),
      actionKinds: [],
    }],
  }), { mode: 0o600 });
  const environment = {
    PRAXIS_CONFIG_FILE: settings, PRAXIS_MCP_CONFIG_FILE: authority,
    PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator), PRAXIS_HERMES_ORIGIN: origin,
    PRAXIS_HERMES_API_KEY: apiKey, PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID: principalId,
    XDG_DATA_HOME: join(directory, "data"), XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"),
  };
  const evidence = process.env.PRAXIS_DESKTOP_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const open = async () => {
    desktop = await startDesktop(binary, { environment });
    assert.equal((await desktop.handles()).length, 1);
    await desktop.waitForText("h1", "Manager");
    await desktop.waitForText("praxis-host-launch [role=status]", "Local Praxis host ready.");
    assert.equal(await desktop.execute("return getComputedStyle(document.querySelector('praxis-shell')).display"), "grid");
  };
  const command = async (value) => {
    const field = await desktop.element('input[aria-label="Command"]');
    await field.click();
    await field.clear();
    await field.type(value + enter);
  };
  const unlock = async (name) => {
    const form = `form[aria-label="Open ${name}"]`;
    const credential = await desktop.element(`${form} input[type="password"]`);
    await credential.type(operator);
    await (await desktop.element(`${form} button[type="submit"]`)).click();
  };
  const visible = (selector) => desktop.execute("return !!document.querySelector(arguments[0])?.getClientRects().length", selector);
  const containing = (selector, value) => desktop.execute(
    "return Array.from(document.querySelectorAll(arguments[0])).some(node => node.textContent.includes(arguments[1]))",
    selector, value,
  );

  await open();
  assert.equal(await visible('form[aria-label="Open Manager"]'), true, "The packaged named Manager exposes operator access.");
  await unlock("Manager");
  await eventually(() => visible("#manager-lock"), "Manager did not authorize.");
  await command(firstPrompt);
  await eventually(() => containing('[role="log"] li', reply), "Manager did not stream native output.");
  assert.equal(managerCalls, 1);

  await command("/o");
  await desktop.waitForText("h1", "Overview");
  await unlock("Overview");
  await eventually(() => containing(".session-pane", workerText), "The live worker output was not displayed.");
  assert.equal((await runtime.inspectAssignment(assignments[0])).status, "running");
  await eventually(() => containing(".session-pane", longTail), "Bounded completed worker output was not displayed.");
  await eventually(() => containing(".session-pane", "Earlier output omitted."), "The replay window did not expose truncation.");
  const live = `.session-pane[data-session-id="${workers[0].session.id}"]`;
  const finished = `.session-pane[data-session-id="${workers[1].session.id}"]`;
  assert.ok(await desktop.execute("return document.querySelector(arguments[0] + ' pre').textContent.length <= 16408", finished));
  await (await desktop.element(`${live} button[aria-expanded]`)).click();
  await (await desktop.element(`${finished} button[aria-expanded]`)).click();
  assert.equal(await desktop.execute('return document.querySelectorAll(".session-pane button[aria-expanded=true]").length'), 1);
  await eventually(() => containing(finished, "Input tokens"), "Reported native usage was not shown.");
  const motion = await desktop.execute("return { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, animation: getComputedStyle(document.querySelector('praxis-overview')).animationName };");
  if (motion.reduced) assert.equal(motion.animation, "none");
  else assert.match(motion.animation, /overview-enter$/);
  if (evidence) await desktop.screenshot(join(evidence, "overview-live-workers.png"));

  await command("/m");
  await desktop.waitForText("#manager-lock", "Lock manager");
  await (await desktop.element("#manager-lock")).click();
  await unlock("Manager");
  await (await desktop.element("#manager-reconnect")).click();
  await eventually(() => containing('[role="log"] li', reply), "Reconnect lost output.");
  releaseManager();
  const related = '[aria-label="Related work"]';
  const selectors = `${related} button[aria-expanded]`;
  const panel = `${related} article`;
  await eventually(() => visible(panel), "Scoped cards did not automatically open.");
  assert.equal(managerCalls, 1, "The same turn was not submitted twice.");
  assert.equal(await containing(related, foreign.title), false);
  const labels = await desktop.execute(
    "return Array.from(document.querySelectorAll(arguments[0]), button => button.textContent.trim())", selectors,
  );
  assert.equal(labels[0], workers[0].task.title);
  assert.match(labels[1], /Worker session/);
  assert.deepEqual(labels.slice(2), ["Task unavailable", "Task unavailable"]);
  assert.equal(await containing(panel, workers[0].task.id), true);
  if (evidence) await desktop.screenshot(join(evidence, "manager-scoped-cards.png"));

  await (await desktop.element(`${selectors}:nth-child(2)`)).click();
  await eventually(() => containing(panel, workers[0].session.id), "Worker session details did not open.");
  await (await desktop.element(`${selectors}:nth-child(3)`)).click();
  await eventually(() => containing(panel, "Task unavailable"), "The denied task did not show its unavailable state.");
  assert.equal(await containing(panel, foreign.id), false);
  if (evidence) await desktop.screenshot(join(evidence, "manager-unavailable-card.png"));
  await (await desktop.element(`${selectors}:first-child`)).click();
  await (await desktop.element(`${panel} button.dismiss`)).click();
  assert.equal(await visible(panel), false);
  assert.equal(await containing(selectors, workers[0].task.title), false);

  await updateSettings(settings, (value) => ({ ...value, display: { ...value.display, autoPresent: false } }));
  await command(secondPrompt);
  await eventually(() => containing('[role="log"] li', "Presentation preference observed."), "The next turn did not render.");
  assert.equal(await desktop.execute(
    'return Array.from(document.querySelectorAll("[role=log] li")).at(-1).querySelectorAll(arguments[0]).length', related,
  ), 0);

  await desktop.close();
  desktop = undefined;
  assert.equal((await runtime.inspectAssignment(assignments[0])).status, "running");
  await open();
  await unlock("Manager");
  await eventually(() => containing('[role="log"] li', reply), "Reopening did not recover the named manager transcript.");
  await command("/o");
  await desktop.waitForText("h1", "Overview");
  await unlock("Overview");
  await eventually(() => containing(".session-pane", workerText), "Reopening did not reconnect the worker output.");
  assert.equal(managerCalls, 1);
  t.diagnostic("Native named Manager streamed and reconnected one turn, scoped cards and preference, retained native transcript, and recovered a running worker after desktop reopen.");
});
