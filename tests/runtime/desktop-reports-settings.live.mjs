import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { defaultSettings, readSettings, saveSettings } from "@praxis/settings";
import { OperationalStore } from "@praxis/state";
import { populateReports } from "../fixtures/reports.mjs";
import { desktopPackageRoot, enter, eventually, startDesktop } from "./desktop-fixture.mjs";

const up = "\uE013";
const portableForm = 'form[aria-label="Portable settings"]';
const reportUnlock = 'form[aria-label="Open reports"]';
const preferences = 'form[aria-label="Report preferences"]';

async function fixture(t) {
  const deb = process.env.PRAXIS_DESKTOP_DEB;
  assert.ok(deb && isAbsolute(deb), "Set PRAXIS_DESKTOP_DEB to the absolute development package path.");
  const directory = await mkdtemp(join(tmpdir(), "praxis-desktop-reports-settings-"));
  const home = join(directory, "home");
  const config = join(home, ".config");
  const downloads = join(home, "Downloads");
  const settings = join(config, "praxis", "settings.json");
  const database = join(directory, "operations.sqlite");
  const token = randomBytes(24).toString("hex");
  let app;
  async function close() {
    const previous = app;
    app = undefined;
    await previous?.close();
  }
  t.after(async () => {
    try {
      await close();
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    }
  });
  await mkdir(config, { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(join(config, "user-dirs.dirs"), 'XDG_DOWNLOAD_DIR="$HOME/Downloads"\n');
  const installed = desktopPackageRoot(deb, directory);
  const environment = Object.fromEntries(Object.keys(process.env)
    .filter((name) => name.startsWith("PRAXIS_"))
    .map((name) => [name, undefined]));
  Object.assign(environment, {
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PRAXIS_CONFIG_FILE: settings,
    PRAXIS_REPORTS_DATABASE: database,
    PRAXIS_OPERATOR_TOKEN_DIGEST: createHash("sha256").update(token).digest("hex"),
  });
  const open = async () => {
    app = await startDesktop(join(installed, "usr/bin/praxis-desktop"), { environment });
    assert.equal((await app.handles()).length, 1);
    await app.waitForText("praxis-host-launch [role=status]", "Local Praxis host ready.");
    return app;
  };
  return { open, close, settings, database, token, downloads };
}

async function navigate(app, route) {
  const command = await app.element('[aria-label="Command"]');
  await command.clear();
  await command.type(`/${route.toLowerCase()}${enter}`);
  await app.waitForText("h1", route);
}

async function setInput(app, selector, value) {
  const input = await app.element(selector);
  await input.clear();
  await input.type(value);
}

async function assertNarrow(app) {
  await app.resize(360, 620);
  await eventually(() => app.execute(`
    const main = document.querySelector("main");
    const composer = document.querySelector("praxis-command-bar form");
    return window.innerWidth === 360 && window.innerHeight === 620 && main.scrollWidth <= main.clientWidth
      && main.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top;
  `), "The rendered desktop view did not fit its narrow viewport.");
  assert.equal(await app.execute(`
    const shell = document.querySelector("praxis-shell");
    const nonce = shell.getAttribute("ngCspNonce");
    const authenticatedStyle = [...document.querySelectorAll("style")].some((style) => style.nonce === nonce);
    return !!nonce && nonce !== "__TAURI_STYLE_NONCE__" && authenticatedStyle && getComputedStyle(shell).display === "grid";
  `), true, "The packaged WebKit must apply Tauri-nonced Angular component styles.");
}

async function customizeReports(app, expanded = true) {
  const toggle = '[aria-controls="report-customization"]';
  await (await app.element(toggle)).type(enter);
  await eventually(() => app.execute("return document.querySelector(arguments[0])?.getAttribute('aria-expanded') === arguments[1]",
    toggle, String(expanded)), "Keyboard activation did not change report customization.");
}

async function capture(app, name) {
  const evidence = process.env.PRAXIS_DESKTOP_EVIDENCE_DIR;
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await app.screenshot(join(evidence, name));
}

test("packaged Settings edits an existing portable file, rejects invalid settings and restores them after restart", {
  timeout: 90_000,
}, async (t) => {
  const { open, close, settings } = await fixture(t);
  const initial = defaultSettings();
  initial.manager.profile = "existing-manager";
  initial.worker.model = "legacy-worker";
  await saveSettings(settings, initial);
  let app = await open();
  await navigate(app, "Settings");
  await eventually(() => app.execute("return !!document.querySelector(arguments[0])", portableForm),
    "The packaged Settings page did not open the portable editor after reading the local host.");
  await eventually(() => app.execute("return document.querySelector('[name=managerProfile]')?.value === 'existing-manager'"),
    "The desktop editor did not read the existing settings.");
  await assertNarrow(app);
  assert.equal(await app.execute(`
    const save = document.querySelector('praxis-settings button[type=submit]').getBoundingClientRect();
    const main = document.querySelector("main").getBoundingClientRect();
    return save.top >= main.top && save.bottom <= main.bottom;
  `), true, "Save settings is visible in the narrow workspace before scrolling.");
  await setInput(app, "[name=managerProfile]", "desktop-manager");
  await (await app.element("[name=autoPresent]")).click();
  await (await app.element(`${portableForm} button[type=submit]`)).click();
  await app.waitForText("praxis-settings [role=status]", "Settings saved.");
  assert.equal((await readSettings(settings)).manager.profile, "desktop-manager");
  assert.equal((await readSettings(settings)).worker.model, "legacy-worker");
  assert.equal((await readSettings(settings)).display.autoPresent, false);
  await capture(app, "settings-saved-narrow.png");

  await setInput(app, "[name=managerProfile]", "INVALID PROFILE");
  await (await app.element(`${portableForm} button[type=submit]`)).click();
  await app.waitForText("praxis-settings [role=status]", /settings.*(valid|check)|Check.*settings/i);
  assert.equal((await readSettings(settings)).manager.profile, "desktop-manager");
  assert.doesNotMatch(await readFile(settings, "utf8"), /INVALID PROFILE|operatorToken|apiKey/);
  await app.execute("document.querySelector('praxis-settings [role=status]').scrollIntoView({block:'nearest'})");
  await capture(app, "settings-validation-narrow.png");

  await close();
  app = await open();
  await navigate(app, "Settings");
  await eventually(() => app.execute("return document.querySelector('[name=managerProfile]')?.value === 'desktop-manager'"),
    "The saved setting did not survive a desktop restart.");
  assert.equal(await app.execute("return document.querySelector('[name=autoPresent]').checked"), false);
  await assertNarrow(app);
  await capture(app, "settings-reopened-narrow.png");
});

test("packaged Reports charts operational values, scopes export, and clears history without deleting audit records", {
  timeout: 90_000,
}, async (t) => {
  const { open, close, settings, database, token, downloads } = await fixture(t);
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const store = new OperationalStore(database);
  populateReports(store, day);
  const auditsBefore = store.eventsOfKind("usage.observed").length;
  store.close();
  let app = await open();
  await navigate(app, "Reports");
  assert.equal(await app.execute("return !!document.querySelector(arguments[0])", reportUnlock), true,
    "The packaged Reports page should offer scoped operator unlock.");
  assert.equal(await app.execute("return document.querySelector('canvas') === null"), true);
  await setInput(app, `${reportUnlock} [name=operatorToken]`, "x".repeat(48));
  await (await app.element(`${reportUnlock} button[type=submit]`)).click();
  await app.waitForText("praxis-reports [data-reports-status]", /credential.*(denied|refused|rejected)/i);
  await setInput(app, `${reportUnlock} [name=operatorToken]`, token);
  await (await app.element(`${reportUnlock} button[type=submit]`)).click();

  await app.waitForText('[data-metric="tokens"] [data-chart-summary]', /20 on/);
  await app.waitForText('[data-metric="costUsd"] [data-chart-summary]', /0 on/);
  await eventually(() => app.execute(`
    const canvas = document.querySelector('[data-metric="tokens"] canvas');
    if (!canvas?.width) return false;
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((v) => v !== 0);
  `), "The bundled Chart.js did not draw the token chart.");
  assert.equal(await app.execute("return document.querySelector('[data-report-export]').disabled"), true);
  await assertNarrow(app);
  await app.execute("document.querySelector('[name=reportRange]').focus()");
  await (await app.element("[name=reportRange]")).type(up + enter);
  await eventually(() => app.execute('return document.querySelector(\'[data-metric="tokens"] canvas\')?.getAttribute("aria-label")?.includes("7 days")'),
    "The keyboard range change did not redraw the 7-day chart.");
  await app.execute("document.querySelector('[data-metric=tokens] canvas').scrollIntoView({block:'center'})");
  await capture(app, "reports-measured-narrow.png");

  await customizeReports(app);
  await (await app.element(`${preferences} [name=allowExport]`)).click();
  await (await app.element(`${preferences} [name=allowClearHistory]`)).click();
  await (await app.element(`${preferences} [name=metric_interventions]`)).click();
  await app.execute("document.querySelector('[name=retentionDays]').focus()");
  await (await app.element("[name=retentionDays]")).type(up + up + enter);
  await (await app.element(`${preferences} button[type=submit]`)).click();
  await app.waitForText("praxis-reports [data-reports-status]", "Report preferences saved.");
  const configured = (await readSettings(settings)).reports;
  assert.equal(configured.retentionDays, 7);
  assert.equal(configured.visibleMetrics.includes("interventions"), false);
  assert.equal(configured.allowExport, true);
  const preview = await app.element(`${preferences} [name=metric_taskMinutes]`);
  await preview.click();
  assert.equal(await app.execute("return document.querySelector('[data-report-export]').disabled"), false);
  await (await app.element("[data-report-export]")).click();
  const exportFile = await eventually(() => readFile(join(downloads, "praxis-report.json"), "utf8").catch(() => false),
    "The packaged export never reached the Downloads folder.");
  const report = JSON.parse(exportFile);
  assert.equal(report.days, 7);
  const row = report.buckets.find(({ day: date }) => date === day);
  assert.equal(row.metrics.tokens, 20);
  assert.equal(row.metrics.costUsd, 0);
  assert.equal("interventions" in row.metrics, false);
  assert.equal("taskMinutes" in row.metrics, false);
  assert.equal((await readSettings(settings)).reports.visibleMetrics.includes("taskMinutes"), true);
  assert.ok(report.buckets.some(({ metrics }) => metrics.tokens === null));
  await capture(app, "reports-export-narrow.png");
  await preview.click();

  async function changeCollection(enabled) {
    await (await app.element(`${preferences} [name=collectionEnabled]`)).click();
    await (await app.element(`${preferences} button[type=submit]`)).click();
    await app.waitForText("praxis-reports [data-reports-status]", "Report preferences saved.");
    assert.equal((await readSettings(settings)).reports.collectionEnabled, enabled);
  }
  await changeCollection(false);
  assert.equal(await app.execute(`
    const reports = document.querySelector("praxis-reports");
    return reports.textContent.includes("Report collection is paused.")
      && reports.querySelector("canvas") === null && reports.querySelector("[data-report-export]").disabled;
  `), true);
  await changeCollection(true);
  await app.waitForText('[data-metric="tokens"] [data-chart-summary]', /20 on/);

  await customizeReports(app, false);
  await app.execute("document.querySelector('[data-report-clear]').scrollIntoView({block:'center'})");
  await (await app.element("[data-report-clear]")).click();
  const keep = '#report-clear-confirmation button:first-of-type';
  await eventually(() => app.execute("return document.activeElement === document.querySelector(arguments[0])", keep),
    "The history confirmation did not focus Keep history.");
  await (await app.element(keep)).type("\uE00C");
  assert.equal(await app.execute("return document.activeElement === document.querySelector('[data-report-clear]')"), true);
  assert.equal((await readSettings(settings)).reports.clearedBefore, undefined);
  await (await app.element("[data-report-clear]")).click();
  await (await app.element("[data-confirm-report-clear]")).click();
  await app.waitForText("praxis-reports [data-reports-status]", "Report history cleared.");
  await app.waitForText('[data-metric="tokens"] [data-chart-summary]', "No measurements in this range.");
  const audit = new OperationalStore(database);
  assert.equal(audit.eventsOfKind("usage.observed").length, auditsBefore);
  audit.close();
  const persisted = (await readSettings(settings)).reports;
  assert.ok(persisted.clearedBefore);

  const lock = await app.element("[data-report-lock]");
  await lock.click();
  await app.element(reportUnlock);
  assert.equal(await app.execute("return document.querySelector('praxis-reports canvas') === null"), true);

  await navigate(app, "Settings");
  await eventually(() => app.execute("return !!document.querySelector('[name=managerProfile]')"),
    "Settings did not load after changing report preferences.");
  await (await app.element(`${portableForm} button[type=submit]`)).click();
  await app.waitForText("praxis-settings [role=status]", "Settings saved.");
  assert.deepEqual((await readSettings(settings)).reports, persisted);
  await close();
  app = await open();
  await navigate(app, "Reports");
  await setInput(app, `${reportUnlock} [name=operatorToken]`, token);
  await (await app.element(`${reportUnlock} button[type=submit]`)).click();
  await app.waitForText('[data-metric="tokens"] [data-chart-summary]', "No measurements in this range.");
  assert.equal(await app.execute("return document.querySelector('[name=reportRange]').value"), "7");
  await customizeReports(app);
  assert.equal(await app.execute("return document.querySelector('[name=retentionDays]').value"), "7");
  await capture(app, "reports-cleared-reopened.png");
});
