import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

let browser;
let host;
let directory;
let address;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "praxis-shell-browser-"));
  host = spawn(process.execPath, ["packages/shell/dist/cli.js"], {
    env: { ...process.env, PRAXIS_PORT: "0", PRAXIS_CONFIG_FILE: join(directory, "settings.json") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const log = await Promise.race([
    once(host.stdout, "data").then(([value]) => value.toString()),
    once(host, "exit").then(([code]) => { throw new Error(`Praxis exited before listening (${code})`); }),
  ]);
  address = /http:\/\/127\.0\.0\.1:\d+\//.exec(log)?.[0];
  assert.ok(address, "Praxis printed its loopback address");
  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
});

after(async () => {
  await browser?.close();
  if (host?.exitCode === null && host.signalCode === null) {
    host.kill();
    await once(host, "exit");
  }
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

async function openPage(t, viewport) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(3_000);
  t.after(() => page.close());
  await page.goto(address);
  return page;
}

async function command(page, value) {
  const field = page.getByRole("textbox", { name: "Command", exact: true });
  await field.fill(value);
  await field.press("Enter");
}

async function navigate(page, name) {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
}

async function heading(page, name) {
  await page.getByRole("heading", { level: 1, name, exact: true }).waitFor();
}

async function assertLayout(page) {
  const [header, content, bar, input] = await Promise.all([
    page.locator("#shell-header").boundingBox(),
    page.locator("#workspace").boundingBox(),
    page.locator("#command-bar").boundingBox(),
    page.getByRole("textbox", { name: "Command", exact: true }).boundingBox(),
  ]);
  assert.ok(header && content && bar && input, "core shell regions are visible");
  assert.ok(header.y + header.height <= content.y, "menu stays above workspace");
  assert.ok(content.y + content.height <= bar.y, "command bar stays below workspace");
  assert.ok(input.y >= bar.y && input.y + input.height <= page.viewportSize().height, "command remains in viewport");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

test("the command bar stays visible without overlap at desktop and narrow sizes", async (t) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 620 }]) {
    const page = await openPage(t, viewport);
    await heading(page, "Manager");
    await assertLayout(page);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("navigation").waitFor();
    await assertLayout(page);
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("navigation").isVisible(), false);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await heading(page, "Overview");
    assert.equal(await page.getByRole("navigation").isVisible(), false);
    await assertLayout(page);
  }
});

test("full, short, help and unknown commands resolve without network requests", async (t) => {
  const page = await openPage(t, { width: 960, height: 720 });
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  for (const [spelling, view] of [
    ["/overview", "Overview"], ["/manager", "Manager"], ["/o", "Overview"], ["/m", "Manager"],
  ]) {
    await command(page, spelling);
    await heading(page, view);
  }
  for (const spelling of ["/help", "/h"]) {
    await command(page, spelling);
    await page.getByRole("status").getByText(/\/manager.*\/overview.*\/help/).waitFor();
  }
  await command(page, "/unknown");
  await page.getByRole("status").getByText(/Unknown command.*\/help/).waitFor();
  assert.deepEqual(requests, []);
});

test("menu and history switches preserve both views and their command drafts", async (t) => {
  const page = await openPage(t, { width: 960, height: 720 });
  const input = page.getByRole("textbox", { name: "Command", exact: true });
  const manager = await page.locator('[data-view="manager"]').elementHandle();
  const overview = await page.locator('[data-view="overview"]').elementHandle();
  for (const panel of [manager, overview]) {
    await panel.evaluate((element) => {
      const child = document.createElement("div");
      child.style.blockSize = "1600px";
      element.append(child);
    });
  }
  await manager.evaluate((element) => { element.scrollTop = 120; });
  await input.fill("Manager draft");
  await navigate(page, "Overview");
  await heading(page, "Overview");
  await overview.evaluate((element) => { element.scrollTop = 80; });
  await input.fill("Overview draft");
  await navigate(page, "Manager");
  await heading(page, "Manager");
  assert.equal(await input.inputValue(), "Manager draft");
  assert.equal(await manager.evaluate((element) => element.scrollTop), 120);
  await page.goBack();
  await heading(page, "Overview");
  assert.equal(await input.inputValue(), "Overview draft");
  assert.equal(await overview.evaluate((element) => element.scrollTop), 80);
  assert.equal(await manager.evaluate((element) => element === document.querySelector('[data-view="manager"]')), true);
  assert.equal(await overview.evaluate((element) => element === document.querySelector('[data-view="overview"]')), true);
});

test("the settings route composes the local editor within the permanent shell", async (t) => {
  const page = await openPage(t, { width: 360, height: 620 });
  await command(page, "/s");
  const frame = page.frameLocator('iframe[title="Praxis settings"]');
  await frame.getByRole("heading", { name: "Praxis settings" }).waitFor();
  const applyAxiom = frame.getByRole("checkbox", { name: "Apply Axiom policy" });
  await applyAxiom.uncheck();
  await frame.getByRole("button", { name: "Save settings" }).click();
  await frame.getByRole("status").getByText("Settings saved.").waitFor();
  await assertLayout(page);
  await command(page, "/m");
  await heading(page, "Manager");
  await command(page, "/settings");
  await frame.getByRole("heading", { name: "Praxis settings" }).waitFor();
  assert.equal(await applyAxiom.isChecked(), false);
  await assertLayout(page);
});
