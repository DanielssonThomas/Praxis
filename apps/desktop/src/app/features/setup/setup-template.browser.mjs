import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopBrowserSuite } from "../../shell/desktop-browser-fixture.mjs";

const { open, capture } = desktopBrowserSuite();
const wide = { width: 1280, height: 800 };
const narrow = { width: 360, height: 620 };

function installFixture() {
  let host = "starting";
  let retries = 0;
  let unlocks = 0;
  window.isTauri = true;
  window.setupFixture = {
    failHost() { host = "unavailable"; },
    requests() { return { retries, unlocks }; },
  };
  window.__TAURI_INTERNALS__ = {
    async invoke(command) {
      switch (command) {
        case "host_status":
          if (host === "unavailable") {
            throw { code: "host_unavailable", message: "The local Praxis host resources are missing." };
          }
          return host === "ready"
            ? { stage: "ready", nodeVersion: "24.22.3" }
            : { stage: "starting", nodeVersion: null, retryAfterMs: 40 };
        case "retry_host":
          retries += 1;
          host = "ready";
          return null;
        case "unlock_manager":
          unlocks += 1;
          throw { code: "setup_required", message: "Configure the local operator and named Hermes manager." };
        default:
          throw new Error(`Unexpected fixture command: ${command}`);
      }
    },
  };
}

async function command(page, value) {
  const field = page.getByRole("textbox", { name: "Command", exact: true });
  await field.fill(value);
  await field.press("Enter");
}

function focused(locator) {
  return locator.evaluate((node) => node === document.activeElement);
}

async function assertLayout(page) {
  const main = page.getByRole("main");
  assert.equal(await main.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

test("Setup is a keyboard-accessible configuration destination from a fresh window", async (t) => {
  const page = await open(t, wide, "setup-menu");
  await page.getByRole("heading", { name: "Manager", level: 1 }).waitFor();
  await page.getByRole("button", { name: "Menu" }).press("Enter");
  const config = page.getByRole("group", { name: "Configuration" });
  await config.getByRole("link", { name: "Settings", exact: true }).waitFor();
  const setup = config.getByRole("link", { name: "Setup", exact: true });
  assert.equal(await setup.count(), 1, "the configuration menu must offer a Setup destination");
  await setup.press("Enter");
  await page.getByRole("heading", { name: "Setup", level: 1 }).waitFor();
  await page.getByText("Open the Linux x64 Praxis desktop package to check the local host.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry local host" }).count(), 0);
  await capture(page, "setup-browser-unavailable");
});

for (const viewport of [wide, narrow]) {
  test(`Setup guides host recovery and Manager handoff at ${viewport.width} × ${viewport.height}`, async (t) => {
    const page = await open(t, viewport, `setup-keyboard-${viewport.width}`, "", { initialize: installFixture });
    await page.getByRole("heading", { name: "Manager", level: 1 }).waitFor();
    await command(page, viewport.width === wide.width ? "/setup" : "/su");
    await page.getByRole("heading", { name: "Setup", level: 1 }).waitFor();
    const guide = page.getByRole("region", { name: "Check the local Praxis host" });
    const status = guide.getByRole("status");
    const steps = page.getByRole("navigation", { name: "Setup steps" });
    await status.getByText("Starting the local Praxis host.", { exact: true }).waitFor();
    assert.equal(await steps.getByRole("button", { name: "Local host" }).getAttribute("aria-current"), "step");
    await page.evaluate(() => window.setupFixture.failHost());
    await status.getByText("The local Praxis host resources are missing.", { exact: true }).waitFor();
    await guide.getByText("Check the desktop installation, then retry the local host.").waitFor();
    await assertLayout(page);
    await capture(page, `setup-host-missing-${viewport.width}`);
    await guide.getByRole("button", { name: "Retry local host" }).press("Enter");
    await status.getByText("Node.js 24.22.3", { exact: true }).waitFor();
    assert.equal(await focused(status), true);
    assert.deepEqual(await page.evaluate(() => window.setupFixture.requests()), { retries: 1, unlocks: 0 });
    await capture(page, `setup-host-ready-${viewport.width}`);

    const next = page.getByRole("button", { name: "Continue" });
    await next.press("Enter");
    const profile = page.getByRole("heading", { name: "Connect a named Hermes profile" });
    await profile.waitFor();
    assert.equal(await focused(profile), true);
    assert.equal(await steps.getByRole("button", { name: "Hermes profile" }).getAttribute("aria-current"), "step");
    assert.match(await page.getByRole("link", { name: "Open Settings" }).getAttribute("href"), /#\/settings$/);
    await page.getByText("Install and connect the default manager", { exact: true }).press("Enter");
    await page.getByText(/\/usr\/lib\/Praxis\/host\/setup\/install-hermes-manager\.mjs/).waitFor();
    await page.getByText("PRAXIS_HERMES_ORIGIN", { exact: true }).waitFor();
    assert.equal(await page.getByText("PRAXIS_MCP_CONFIG_FILE", { exact: true }).count(), 1,
      "the guide identifies the authority file required by the configured local host");
    assert.match(await guide.getByRole("link", { name: "Axiom v1.0.0" }).getAttribute("href"), /Axiom\/releases\/tag\/v1\.0\.0$/);
    await assertLayout(page);
    await capture(page, `setup-profile-${viewport.width}`);
    await next.press("Enter");
    const access = page.getByRole("heading", { name: "Open Manager with your operator token" });
    await access.waitFor();
    assert.equal(await focused(access), true);
    assert.equal(await page.getByRole("main").locator("input").count(), 0);
    await page.getByText("PRAXIS_OPERATOR_TOKEN_DIGEST", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Back", exact: true }).press("Enter");
    await profile.waitFor();
    await steps.getByRole("button", { name: "Operator access" }).press("Enter");
    await access.waitFor();
    await capture(page, `setup-operator-${viewport.width}`);
    await page.getByRole("link", { name: "Open Manager", exact: true }).press("Enter");
    const form = page.getByRole("form", { name: "Open Manager" });
    await form.waitFor();
    assert.deepEqual(await page.evaluate(() => window.setupFixture.requests()), { retries: 1, unlocks: 0 });
    await form.getByLabel("Operator token").fill("fixture-operator");
    await form.getByRole("button", { name: "Open manager", exact: true }).press("Enter");
    await page.getByText("Configure the local operator and named Hermes manager.", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.setupFixture.requests()), { retries: 1, unlocks: 1 });
  });
}
