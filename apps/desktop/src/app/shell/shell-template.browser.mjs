import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const bundle = new URL("../../../dist/browser/", import.meta.url);
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[\w.-]+$/.test(file)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(new URL(file, bundle));
    response.writeHead(200, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    response.writeHead(404).end("Angular desktop build unavailable");
  }
});
const traces = process.env.PRAXIS_UI_EVIDENCE_DIR;
let browser;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
  if (traces) await mkdir(traces, { recursive: true });
  console.log(`Desktop bundle exercised in Chromium ${browser.version()} on ${process.platform} ${process.arch}`);
});

after(async () => {
  await browser?.close();
  server.close();
});

async function open(t, viewport, observation, fragment = "") {
  const context = await browser.newContext({ viewport });
  if (traces) await context.tracing.start({ screenshots: true, snapshots: true });
  t.after(async () => {
    if (traces) await context.tracing.stop({ path: join(traces, `${observation}.zip`) });
    await context.close();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(2_500);
  const response = await page.goto(`http://127.0.0.1:${server.address().port}/${fragment}`);
  assert.equal(response?.status(), 200, "the desktop bundle serves its Angular entry point");
  return page;
}

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
    await page.keyboard.press("Tab");
    assert.equal(await menu.evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    await nav.waitFor();
    assert.equal(await menu.getAttribute("aria-expanded"), "true");
    await assertLayout(page);
    await page.keyboard.press("Tab");
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
}

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
