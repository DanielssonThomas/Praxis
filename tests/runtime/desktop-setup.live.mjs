import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { defaultSettings } from "@praxis/settings";
import { enter, eventually, startDesktop } from "./desktop-fixture.mjs";
import { startNamedHermesFixture } from "./named-hermes-fixture.mjs";

const profile = "praxis-desktop-setup-fixture";
const reply = "The configured named Hermes profile answered.";
const hostStatus = "#setup-host-status";
const guideHeading = "#setup-step-heading";
const operatorInput = 'form[aria-label="Open Manager"] input[type="password"]';

async function command(desktop, value) {
  const field = await desktop.element('[aria-label="Command"]');
  await field.click();
  await field.clear();
  await field.type(value + enter);
}

test("packaged Setup recovers a missing sidecar and hands off authenticated Manager access", {
  timeout: 120_000,
}, async (t) => {
  const packagePath = process.env.PRAXIS_DESKTOP_DEB;
  assert.ok(packagePath && isAbsolute(packagePath), "Set PRAXIS_DESKTOP_DEB to the absolute development package path.");
  const directory = await mkdtemp(join(tmpdir(), "praxis-desktop-setup-"));
  let desktop;
  t.after(async () => {
    try {
      await desktop?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const installed = join(directory, "installed");
  execFileSync("dpkg-deb", ["--extract", packagePath, installed], { timeout: 20_000 });
  const binary = join(installed, "usr/bin/praxis-desktop");
  const sidecar = join(installed, "usr/lib/Praxis/host/bin/node");
  const withheld = join(directory, "withheld-node");
  const configPath = join(directory, "settings.json");
  const defaults = defaultSettings();
  const settings = JSON.stringify({ ...defaults, manager: { ...defaults.manager, profile } });
  await writeFile(configPath, settings, { mode: 0o600 });
  const operator = randomBytes(32).toString("base64url");
  const { origin, apiKey } = await startNamedHermesFixture(t, profile,
    () => ({ message: { role: "assistant", content: reply } }));
  const environment = {
    HOME: directory, XDG_DATA_HOME: join(directory, "data"),
    XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
    PRAXIS_CONFIG_FILE: configPath, PRAXIS_HERMES_ORIGIN: origin, PRAXIS_HERMES_API_KEY: apiKey,
    PRAXIS_OPERATOR_TOKEN_DIGEST: createHash("sha256").update(operator).digest("hex"),
  };
  const evidence = process.env.PRAXIS_DESKTOP_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });

  await rename(sidecar, withheld);
  desktop = await startDesktop(binary, { environment });
  assert.equal((await desktop.handles()).length, 1);
  assert.equal(await desktop.execute("return location.protocol"), "tauri:");
  await desktop.waitForText("h1", "Manager");
  await command(desktop, "/setup");
  await desktop.waitForText("h1", "Setup");
  await desktop.waitForText(hostStatus, "The local Praxis host resources are missing.");
  await desktop.waitForText(".host-check p:nth-child(2)", "Check the desktop installation, then retry the local host.");
  assert.equal(await desktop.execute("return !document.querySelector('praxis-host-launch')"), true);
  const retry = await desktop.element(".host-check button");
  assert.equal(await retry.text(), "Retry local host");
  if (evidence) await desktop.screenshot(join(evidence, "setup-native-missing-host.png"));

  await rename(withheld, sidecar);
  await retry.type(enter);
  await desktop.waitForText(hostStatus, /Local Praxis host ready/);
  await desktop.waitForText(hostStatus + " span", "Node.js " + process.versions.node);
  if (evidence) await desktop.screenshot(join(evidence, "setup-native-ready-host.png"));

  await (await desktop.element("praxis-setup footer button.primary")).type(enter);
  await desktop.waitForText(guideHeading, "Connect a named Hermes profile");
  await desktop.waitForText('praxis-setup a[href="#/settings"]', "Open Settings");
  await (await desktop.element("praxis-setup footer button.primary")).type(enter);
  await desktop.waitForText(guideHeading, "Open Manager with your operator token");
  assert.equal(await desktop.execute("return document.querySelectorAll('praxis-setup input').length"), 0);
  if (evidence) await desktop.screenshot(join(evidence, "setup-native-operator-access.png"));
  await (await desktop.element('praxis-setup a[href="#/manager"]')).type(enter);
  await desktop.waitForText("h1", "Manager");
  await (await desktop.element(operatorInput)).type("invalid-fixture-operator-token" + enter);
  await desktop.waitForText("praxis-manager [role=status]", /operator token was refused/i);
  await (await desktop.element(operatorInput)).clear();
  await (await desktop.element(operatorInput)).type(operator + enter);
  await desktop.waitForText("#manager-lock", "Lock manager");
  await desktop.waitForText("#manager-start", "What are we working on?");
  if (evidence) await desktop.screenshot(join(evidence, "setup-native-manager-unlocked.png"));
  await command(desktop, "Check the configured fixture.");
  await eventually(() => desktop.execute(
    "return Array.from(document.querySelectorAll('[role=log] li')).some(node => node.textContent.includes(arguments[0]))",
    reply,
  ), "The configured named Hermes profile did not answer after the Setup handoff.");
  assert.equal(await readFile(configPath, "utf8"), settings);
  const webkit = execFileSync("pkg-config", ["--modversion", "webkit2gtk-4.1"], { encoding: "utf8" }).trim();
  const viewport = await desktop.execute("return [innerWidth, innerHeight]");
  t.diagnostic(`Linux x64 WebKitGTK ${webkit}, Wry ${desktop.capabilities.browserVersion}, ${viewport.join(" × ")}.`);
  t.diagnostic("Setup showed missing sidecar resources and Retry, recovered the bundled Node host, and handed off to the existing Manager unlock. Operator refusal and one authenticated named Hermes turn passed.");
});
