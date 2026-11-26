import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopBrowserSuite } from "../../shell/desktop-browser-fixture.mjs";

const { open, capture } = desktopBrowserSuite();

function installSettingsFixture() {
  window.settingsFixture = {
    schemaVersion: 1,
    policy: { axiomEnabled: true, profiles: ["fixture-profile"] },
    manager: { runtime: "hermes", profile: "existing-manager", model: null },
    worker: { runtime: "codex", model: "fixture-worker" },
    budgets: { maxTaskTokens: null, maxTaskUsd: null },
    memory: { enabled: true },
    display: { autoPresent: true },
    reports: {
      collectionEnabled: true, retentionDays: 7, visibleMetrics: ["tokens"],
      allowExport: true, allowClearHistory: false,
    },
  };
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      switch (command) {
        case "host_status": return { stage: "ready", nodeVersion: "24.22.3" };
        case "read_settings": return structuredClone(window.settingsFixture);
        case "save_settings": {
          const settings = args.settings;
          if (settings.manager.profile === "INVALID PROFILE") {
            throw { code: "invalid_input", message: "Check the portable settings values." };
          }
          window.settingsFixture = structuredClone(settings);
          return structuredClone(settings);
        }
        default: throw new Error("Unexpected synthetic IPC command " + command);
      }
    },
  };
  window.isTauri = true;
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 620 }]) {
  test("portable Settings groups and reachable keyboard save at " + viewport.width + " × " + viewport.height, async (t) => {
    const page = await open(t, viewport, "settings-panels-" + viewport.width, "#/settings", {
      initialize: installSettingsFixture,
    });
    const form = page.getByRole("form", { name: "Portable settings" });
    await form.waitFor();
    for (const group of ["Policy", "Manager and worker", "Task budgets", "Memory", "Display"]) {
      await form.getByRole("group", { name: group, exact: true }).waitFor();
    }
    const save = form.getByRole("button", { name: "Save settings" });
    const profile = form.getByRole("textbox", { name: "Hermes manager profile" });
    const display = form.getByRole("checkbox", { name: "Present contextual cards automatically" });
    const status = form.getByRole("status");
    const inWorkspace = (node) => {
      const main = document.querySelector("main");
      const bounds = node.getBoundingClientRect();
      const viewport = main.getBoundingClientRect();
      const composer = document.querySelector("praxis-command-bar form").getBoundingClientRect();
      return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom && bounds.bottom <= composer.top
        && main.scrollWidth <= main.clientWidth;
    };
    assert.equal(await save.evaluate(inWorkspace), true);
    assert.equal(await profile.inputValue(), "existing-manager");
    await capture(page, "settings-portable-" + viewport.width);

    const originalReports = await page.evaluate(() => window.settingsFixture.reports);
    await profile.fill("portable-manager");
    await display.press("Space");
    await save.press("Enter");
    await status.getByText("Settings saved.").waitFor();
    const saved = await page.evaluate(() => window.settingsFixture);
    assert.equal(saved.manager.profile, "portable-manager");
    assert.equal(saved.display.autoPresent, false);
    assert.equal(saved.worker.model, "fixture-worker");
    assert.deepEqual(saved.reports, originalReports);

    await profile.fill("INVALID PROFILE");
    await save.press("Enter");
    await status.getByText("Check the portable settings values.").waitFor();
    assert.equal(await status.evaluate(inWorkspace), true);
    assert.equal(await profile.inputValue(), "INVALID PROFILE");
    assert.equal(await page.evaluate(() => window.settingsFixture.manager.profile), "portable-manager");
    await capture(page, "settings-invalid-" + viewport.width);
  });
}
