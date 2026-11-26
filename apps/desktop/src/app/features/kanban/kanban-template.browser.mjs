import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const bundle = new URL("../../../../dist/browser/", import.meta.url);
const evidence = process.env.PRAXIS_UI_EVIDENCE_DIR;
let browser;

before(async () => {
  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
  if (evidence) await mkdir(evidence, { recursive: true });
  console.log(`Kanban bundle exercised in Chromium ${browser.version()} on ${process.platform} ${process.arch}`);
});

after(async () => { await browser?.close(); });

async function open(t, viewport, observation, fixture) {
  const context = await browser.newContext({ viewport, colorScheme: "dark" });
  if (evidence) await context.tracing.start({ screenshots: true, snapshots: true });
  t.after(async () => {
    if (evidence) await context.tracing.stop({ path: join(evidence, `${observation}.zip`) });
    await context.close();
  });
  await context.route("http://127.0.0.1/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const asset = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!/^[\w.-]+$/.test(asset) || asset.startsWith(".")) {
      await route.abort();
      return;
    }
    await route.fulfill({ path: fileURLToPath(new URL(asset, bundle)) });
  });
  await context.addInitScript((initial) => {
    let tasks = initial.tasks;
    let unlocked = false;
    window.isTauri = true;
    window.kanbanFixture = { replaceTasks(replacement) { tasks = replacement; } };
    // Use the typed Tauri entry points with synthetic projections and credentials.
    window.__TAURI_INTERNALS__ = {
      async invoke(command) {
        switch (command) {
          case "host_status": return { stage: "ready", nodeVersion: "24.22.3" };
          case "kanban_list":
            if (initial.setupRequired) throw { kind: "setup_required" };
            if (!unlocked) throw { kind: "operator_required" };
            return { tasks, provider: { available: true } };
          case "kanban_unlock":
            unlocked = true;
            return { tasks, provider: { available: true } };
          default: throw new Error(`Unexpected fixture command: ${command}`);
        }
      },
    };
  }, fixture);
  const page = await context.newPage();
  page.setDefaultTimeout(3_000);
  const response = await page.goto("http://127.0.0.1/#/kanban");
  assert.equal(response?.status(), 200);
  return page;
}

async function unlock(page) {
  const form = page.getByRole("form", { name: "Open Kanban" });
  await form.getByLabel("Operator token").fill("fixture-operator");
  await form.getByRole("button", { name: "Open board", exact: true }).press("Enter");
}

const wide = { width: 1280, height: 800 };
const release = {
  nativeId: "t_ab01",
  task: { id: "task_fixture_release", title: "Plan the fixture release" },
  status: "ready",
  assignee: "fixture-worker",
  links: [],
};

test("a keyboard user can open a task detail and return to the same board card", async (t) => {
  const page = await open(t, wide, "kanban-task-disclosure", { tasks: [release] });
  await unlock(page);
  const card = page.locator(`[data-native-id="${release.nativeId}"]`);
  await card.waitFor();
  const trigger = card.getByRole("button", { name: release.task.title, exact: true });
  assert.equal(await trigger.count(), 1, "the board task title must be a keyboard-operable disclosure");
  const detail = page.getByRole("dialog", { name: release.task.title });
  await trigger.press("Enter");
  await detail.waitFor();
  await detail.getByText(release.nativeId, { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await detail.waitFor({ state: "hidden" });
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
});
