import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopBrowserSuite } from "./desktop-browser-fixture.mjs";

const { open, capture } = desktopBrowserSuite();

function commandField(page) {
  return page.getByRole("textbox", { name: "Command", exact: true });
}

async function command(page, value) {
  await commandField(page).fill(value);
  await commandField(page).press("Enter");
}

async function heading(page, name) {
  await page.getByRole("heading", { level: 1, name, exact: true }).waitFor();
}

async function assertLayout(page) {
  const [menu, workspace, form] = await Promise.all([
    page.getByRole("banner").boundingBox(),
    page.getByRole("main").boundingBox(),
    page.getByRole("form", { name: "Command bar" }).boundingBox(),
  ]);
  assert.ok(menu && workspace && form);
  assert.ok(menu.y + menu.height <= workspace.y, "header and workspace do not overlap");
  assert.ok(workspace.y + workspace.height <= form.y, "workspace and command bar do not overlap");
  assert.ok(form.y + form.height <= page.viewportSize().height, "command bar fits in the viewport");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 620 }]) {
  test(`menu keyboard access and permanent shell layout at ${viewport.width} × ${viewport.height}`, async (t) => {
    const page = await open(t, viewport, `menu-${viewport.width}`);
    const menu = page.getByRole("button", { name: "Menu" });
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await heading(page, "Manager");
    await assertLayout(page);
    await capture(page, "shell-default-" + viewport.width);
    await page.keyboard.press("Tab");
    assert.equal(await menu.evaluate((node) => node === document.activeElement), true);
    assert.equal(await menu.evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
    assert.ok((await menu.boundingBox()).x < 40, "the compact Menu sits at the top left");
    await page.keyboard.press("Enter");
    await nav.waitFor();
    assert.equal(await menu.getAttribute("aria-expanded"), "true");
    await assertLayout(page);
    assert.ok(await nav.getByRole("group", { name: "Workspace" }).getByRole("link", { name: "Manager" }).isVisible());
    assert.ok(await nav.getByRole("group", { name: "Configuration" }).getByRole("link", { name: "Settings" }).isVisible());
    const [rail, content] = await Promise.all([nav.boundingBox(), page.getByRole("main").boundingBox()]);
    const railIsLeft = rail.x + rail.width <= content.x;
    const railIsAbove = rail.y + rail.height <= content.y;
    assert.ok(railIsLeft || railIsAbove, "the open rail leaves workspace controls uncovered");
    await capture(page, "shell-menu-open-" + viewport.width);
    await page.keyboard.press("Tab");
    assert.equal(await nav.getByRole("link", { name: "Manager" }).evaluate((node) => node === document.activeElement), true);
    assert.equal(await nav.getByRole("link", { name: "Manager" }).getAttribute("aria-current"), "page");
    await page.keyboard.press("Escape");
    await nav.waitFor({ state: "hidden" });
    assert.equal(await menu.evaluate((node) => node === document.activeElement), true);
    await menu.press("Enter");
    await nav.getByRole("link", { name: "Overview" }).press("Enter");
    await heading(page, "Overview");
    await nav.waitFor({ state: "hidden" });
    assert.equal(await menu.evaluate((node) => node === document.activeElement), true);
    await assertLayout(page);
  });

  test("local slash suggestions and keyboard selection at " + viewport.width + " × " + viewport.height, async (t) => {
    const page = await open(t, viewport, "composer-suggestions-" + viewport.width);
    await heading(page, "Manager");
    const field = commandField(page);
    const suggestions = page.getByRole("listbox", { name: "Command suggestions" });
    await field.fill("/");
    await suggestions.getByRole("option", { name: /\/help.*\/h/ }).waitFor();
    await field.press("ArrowDown");
    const option = suggestions.getByRole("option", { selected: true });
    await option.waitFor();
    assert.equal(await field.getAttribute("aria-activedescendant"), await option.getAttribute("id"));
    await assertLayout(page);
    await capture(page, "shell-suggestions-" + viewport.width);
    await field.press("Escape");
    await suggestions.waitFor({ state: "hidden" });
    assert.equal(await field.inputValue(), "/");
    assert.equal(await field.evaluate((node) => node === document.activeElement), true);
    await field.fill("/o");
    await suggestions.getByRole("option", { name: /\/overview.*\/o/ }).waitFor();
    await field.press("ArrowDown");
    await field.press("Enter");
    await heading(page, "Overview");
    assert.equal(await field.inputValue(), "");
    assert.equal(await field.evaluate((node) => node === document.activeElement), true);
    await field.fill("/he");
    await suggestions.getByRole("option", { name: /\/help.*\/h/ }).click();
    await page.getByText(/\/manager.*\/overview.*\/help/).waitFor();
    assert.equal(await field.evaluate((node) => node === document.activeElement), true);
  });
}

function installSyntheticDesktop() {
  window.isTauri = true;
  window.shellTestPrompts = [];
  let failed = false;
  let recovered = false;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    async invoke(command, args) {
      switch (command) {
        case "host_status":
          if (recovered) return { stage: "ready", nodeVersion: "24.22.3" };
          if (failed) throw { code: "host_unavailable", message: "The local Praxis host is offline." };
          failed = true;
          return { stage: "starting", nodeVersion: null, retryAfterMs: 200 };
        case "retry_host":
          recovered = true;
          return null;
        case "unlock_manager":
          return [];
        case "unlock_activity":
        case "read_activity":
          return Array.from({ length: 6 }, (_, index) => ({
            requestId: "synthetic-request-" + index,
            actorId: "Fixture worker",
            action: { kind: "guidance", target: { kind: "session", id: "synthetic-session" } },
            phase: { state: "processing" },
          }));
        case "manager_turn":
          window.shellTestPrompts.push(args.request.prompt);
          return null;
        default:
          throw new Error("Unexpected synthetic IPC command " + command);
      }
    },
  };
}

test("the permanent composer sends multiline text and retains native status and Activity access", async (t) => {
  const page = await open(t, { width: 360, height: 620 }, "native-shell-controls", "", {
    initialize: installSyntheticDesktop,
  });
  await page.getByText("Starting the local Praxis host.", { exact: true }).waitFor();
  await page.getByText("The local Praxis host is offline.").waitFor();
  await page.getByRole("button", { name: "Retry local host" }).click();
  await page.getByText("Local Praxis host ready.").waitFor();

  const menu = page.getByRole("button", { name: "Menu" });
  const activity = page.getByRole("button", { name: "Activity", exact: true });
  const activityPanel = page.getByRole("complementary", { name: "Activity" });
  await activity.press("Enter");
  await activityPanel.waitFor();
  await activity.press("Enter");
  await activityPanel.waitFor({ state: "hidden" });
  await menu.press("Enter");
  await menu.press("ArrowDown");
  assert.equal(await page.getByRole("link", { name: "Manager" }).evaluate((node) => node === document.activeElement), true);
  await activity.press("Enter");
  await activityPanel.waitFor();
  assert.equal(await activity.getAttribute("aria-expanded"), "true");
  await activity.press("Enter");
  await activityPanel.waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");

  const unlock = page.getByRole("form", { name: "Open Manager" });
  await unlock.getByLabel("Operator token").fill("synthetic-browser-fixture");
  await unlock.getByRole("button", { name: "Open manager" }).click();
  await unlock.waitFor({ state: "hidden" });
  const field = commandField(page);
  await field.fill("First line");
  await field.press("Shift+Enter");
  await page.keyboard.insertText("Second line");
  assert.equal(await field.inputValue(), "First line\nSecond line");
  assert.deepEqual(await page.evaluate(() => window.shellTestPrompts), []);
  await assertLayout(page);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.shellTestPrompts), ["First line\nSecond line"]);
  assert.equal(await field.inputValue(), "");
});

test("the narrow shell keeps Activity controls and slash options within separate spaces", async (t) => {
  const page = await open(t, { width: 360, height: 620 }, "narrow-activity-and-composer", "", {
    initialize: installSyntheticDesktop,
  });
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  const unlock = page.getByRole("form", { name: "Unlock activity" });
  await unlock.getByLabel("Operator token").fill("synthetic-browser-fixture");
  await unlock.getByRole("button", { name: "Unlock activity" }).click();
  await page.getByRole("button", { name: "Inspect" }).first().waitFor();
  const field = commandField(page);
  await field.fill("/");
  await field.press("ArrowUp");
  const help = page.getByRole("option", { name: /\/help.*\/h/ });
  await help.waitFor();
  const activity = page.getByRole("complementary", { name: "Activity" });
  const [panel, form] = await Promise.all([
    activity.boundingBox(), page.getByRole("form", { name: "Command bar" }).boundingBox(),
  ]);
  assert.ok(panel && form && panel.y + panel.height <= form.y, "Activity stays above the composer and suggestions");
  await assertLayout(page);
  await capture(page, "shell-activity-and-suggestions-360");
  await help.click();
  await page.getByText(/\/manager.*\/overview.*\/help/).waitFor();
  assert.deepEqual(await page.evaluate(() => window.shellTestPrompts), []);
});

test("all navigation spellings, help and unknown commands are handled locally", async (t) => {
  const page = await open(t, { width: 1280, height: 800 }, "local-commands");
  await heading(page, "Manager");
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  for (const [view, short] of [["Overview", "o"], ["Kanban", "k"], ["Reports", "r"], ["Settings", "s"], ["Manager", "m"]]) {
    await command(page, ` /${view.toUpperCase()} `);
    await heading(page, view);
    await command(page, `/${short}`);
    await heading(page, view);
    await assertLayout(page);
    assert.equal(await commandField(page).inputValue(), "");
  }
  for (const spelling of ["/help", "/h"]) {
    await command(page, spelling);
    await page.getByText(/\/manager.*\/overview.*\/help/).waitFor();
  }
  await command(page, "/unrecognized");
  await page.getByText("Unknown command. Try /help.").waitFor();
  assert.equal(await commandField(page).inputValue(), "/unrecognized");
  assert.equal(await commandField(page).evaluate((node) => node === document.activeElement), true);
  assert.deepEqual(requests, []);
});

test("menu navigation and history restore the unsubmitted draft for the selected view", async (t) => {
  const page = await open(t, { width: 360, height: 620 }, "draft-history", "#/overview");
  const field = commandField(page);
  const select = async (name) => {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("link", { name, exact: true }).click();
    await heading(page, name);
  };

  await heading(page, "Overview");
  await field.fill("Overview draft");
  await select("Manager");
  assert.equal(await field.inputValue(), "");
  await field.fill("Manager draft");
  await select("Overview");
  assert.equal(await field.inputValue(), "Overview draft");
  await page.goBack();
  await heading(page, "Manager");
  assert.equal(await field.inputValue(), "Manager draft");
  await page.goForward();
  await heading(page, "Overview");
  assert.equal(await field.inputValue(), "Overview draft");
});

test("the routed Overview respects reduced motion", async (t) => {
  const page = await open(t, { width: 960, height: 720 }, "overview-reduced-motion", "#/overview");
  const animation = () => page.locator("praxis-overview").evaluate((element) => getComputedStyle(element).animationName);
  await heading(page, "Overview");
  assert.match(await animation(), /overview-enter$/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await animation(), "none");
});
