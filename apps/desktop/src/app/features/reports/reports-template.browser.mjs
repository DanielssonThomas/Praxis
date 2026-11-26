import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopBrowserSuite } from "../../shell/desktop-browser-fixture.mjs";

const { open, capture } = desktopBrowserSuite();

function installReportsFixture() {
  const saved = {
    collectionEnabled: true, retentionDays: 90, visibleMetrics: ["tokens", "costUsd", "taskMinutes"],
    allowExport: false, allowClearHistory: false,
  };
  let unlocked = false;
  let cleared = false;
  window.reportFixture = { ranges: [], saves: [], clears: [] };
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      const report = (days) => ({
        days,
        preferences: structuredClone(saved),
        buckets: Array.from({ length: days }, (_, index) => ({
          day: new Date(Date.UTC(2026, 2, 1 - days + index)).toISOString().slice(0, 10),
          metrics: !cleared && index === days - 1 ? { tokens: 20, costUsd: 0 } : {},
        })),
      });
      switch (command) {
        case "host_status": return { stage: "ready", nodeVersion: "24.22.3" };
        case "unlock_reports":
          unlocked = true;
          return report(args.request.days);
        case "read_reports":
          if (!unlocked) throw { code: "locked", message: "Open reports first." };
          window.reportFixture.ranges.push(args.days);
          return report(args.days);
        case "save_report_preferences": {
          const { days, preferences } = args.request;
          window.reportFixture.saves.push(structuredClone(preferences));
          Object.assign(saved, preferences);
          return report(days);
        }
        case "clear_report_history":
          window.reportFixture.clears.push(structuredClone(args));
          cleared = true;
          return report(args.days);
        default: throw new Error("Unexpected synthetic IPC command " + command);
      }
    },
  };
  window.isTauri = true;
}

async function assertLayout(page, view) {
  assert.equal(await view.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
  assert.equal(await page.getByRole("main").evaluate((main) => (
    main.scrollWidth <= main.clientWidth &&
    main.getBoundingClientRect().bottom <= document.querySelector("praxis-command-bar form").getBoundingClientRect().top
  )), true);
}

async function assertFocus(locator) {
  assert.equal(await locator.evaluate((node) => node === document.activeElement), true);
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 620 }]) {
  test("Reports range, keyboard customization and confirmed clear at " + viewport.width + " × " + viewport.height, async (t) => {
    const page = await open(t, viewport, "reports-controls-" + viewport.width, "#/reports", {
      initialize: installReportsFixture,
    });
    const unlock = page.getByRole("form", { name: "Open reports" });
    await unlock.getByLabel("Operator token").fill("synthetic-report-fixture");
    await unlock.getByRole("button", { name: "Open reports" }).click();
    const reports = page.locator("praxis-reports");
    const tokens = reports.locator('[data-metric="tokens"]');
    const cost = reports.locator('[data-metric="costUsd"]');
    const duration = reports.locator('[data-metric="taskMinutes"]');
    await tokens.getByText(/20 on/).waitFor();
    await cost.getByText(/0 on/).waitFor();
    await duration.getByText("No measurements in this range.").waitFor();
    assert.equal(await duration.locator("canvas").count(), 0);

    const range = reports.getByLabel("Range");
    assert.equal(await range.inputValue(), "30");
    await range.press("Home");
    await tokens.getByRole("img", { name: /over 7 days \(UTC\)/ }).waitFor();
    assert.equal(await range.inputValue(), "7");
    await tokens.getByText("6 days without a measurement.", { exact: true }).waitFor();
    const chart = tokens.locator("canvas");
    await page.waitForFunction((selector) => {
      const canvas = document.querySelector(selector);
      return canvas?.width && canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some(Boolean);
    }, '[data-metric="tokens"] canvas');
    assert.ok((await chart.boundingBox()).width > 80);
    await assertLayout(page, reports);
    if (viewport.width === 360) await chart.scrollIntoViewIfNeeded();
    await capture(page, "reports-measured-" + viewport.width);

    const customize = reports.getByRole("button", { name: "Customize reports" });
    const preferences = reports.getByRole("form", { name: "Report preferences" });
    assert.equal(await preferences.isVisible(), false);
    await customize.press("Enter");
    await preferences.waitFor();
    assert.equal(await customize.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Tab");
    await assertFocus(preferences.getByRole("checkbox", { name: "PRs opened (recorded)", exact: true }));
    await preferences.getByRole("checkbox", { name: "Reported cost (USD)", exact: true }).press("Space");
    await cost.waitFor({ state: "hidden" });
    await preferences.getByRole("checkbox", { name: "Allow report export", exact: true }).press("Space");
    await preferences.getByRole("checkbox", { name: "Allow clearing report history", exact: true }).press("Space");
    assert.equal(await reports.getByRole("button", { name: "Export JSON" }).isDisabled(), true);
    await capture(page, "reports-customization-" + viewport.width);
    await preferences.getByRole("button", { name: "Save report preferences" }).press("Enter");
    await reports.getByText("Report preferences saved.").waitFor();
    const [saved] = await page.evaluate(() => window.reportFixture.saves);
    assert.deepEqual(saved.visibleMetrics, ["taskMinutes", "tokens"]);
    assert.equal(saved.allowExport, true);
    assert.equal(saved.allowClearHistory, true);
    assert.equal(await reports.getByRole("button", { name: "Export JSON" }).isEnabled(), true);
    await preferences.getByRole("checkbox", { name: "Reported cost (USD)", exact: true }).press("Space");
    await cost.waitFor();
    assert.equal(await reports.getByRole("button", { name: "Export JSON" }).isDisabled(), true);
    await page.keyboard.press("Escape");
    await preferences.waitFor({ state: "hidden" });
    await assertFocus(customize);
    await cost.waitFor({ state: "hidden" });

    const clear = reports.getByRole("button", { name: "Clear report history", exact: true });
    const confirmation = reports.getByRole("group", { name: "Confirm clearing report history" });
    await clear.press("Enter");
    const keep = confirmation.getByRole("button", { name: "Keep history" });
    await keep.waitFor();
    await assertFocus(keep);
    await page.keyboard.press("Escape");
    await confirmation.waitFor({ state: "hidden" });
    await assertFocus(clear);
    assert.deepEqual(await page.evaluate(() => window.reportFixture.clears), []);
    await clear.press("Enter");
    await confirmation.getByRole("button", { name: "Confirm clear" }).press("Enter");
    await tokens.getByText("No measurements in this range.").waitFor();
    assert.equal(await tokens.locator("canvas").count(), 0);
    assert.deepEqual(await page.evaluate(() => window.reportFixture.clears), [{ days: 7, confirmation: { confirmed: true } }]);
    await capture(page, "reports-unavailable-" + viewport.width);
  });
}
