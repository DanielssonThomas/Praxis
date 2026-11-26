import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopBrowserSuite } from "../../shell/desktop-browser-fixture.mjs";

const { open, capture } = desktopBrowserSuite();

function installFixture(initial) {
  let tasks = initial.tasks;
  let unlocked = false;
  window.isTauri = true;
  window.kanbanFixture = { replaceTasks(replacement) { tasks = replacement; } };
  // The browser fixture supplies synthetic projections through the production Tauri entry points.
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
}

function openKanban(t, viewport, observation, fixture) {
  const initialize = `(${installFixture})(${JSON.stringify(fixture)})`;
  return open(t, viewport, observation, "#/kanban", { initialize });
}

async function unlock(page) {
  const form = page.getByRole("form", { name: "Open Kanban" });
  await form.getByLabel("Operator token").fill("fixture-operator");
  await form.getByRole("button", { name: "Open board", exact: true }).press("Enter");
}

const wide = { width: 1280, height: 800 };
const narrow = { width: 360, height: 620 };
const release = {
  nativeId: "t_ab01",
  task: { id: "task_fixture_release", title: "Plan the fixture release" },
  status: "ready",
  assignee: "fixture-worker",
  links: [],
};
const verifiedIssue = { provider: "github", repository: "fixture/project", number: 42 };
const lanes = [release,
  { ...release, nativeId: "t_ab02", task: { id: "task_fixture_followup", title: "Review fixture follow-up" }, links: [verifiedIssue] },
  { ...release, nativeId: "t_ab03", task: { id: "task_fixture_running", title: "Compile fixture artifacts" }, status: "running" },
  { ...release, nativeId: "t_ab04", task: { id: "task_fixture_review", title: "Review fixture artifacts" }, status: "waiting_for_review" },
  { ...release, nativeId: "t_ab05", task: { id: "task_fixture_blocked", title: "Check " + "fixture".repeat(25) }, status: "blocked" },
  { ...release, nativeId: "t_ab06", task: { id: "task_fixture_done", title: "Publish fixture notes" }, status: "done", assignee: null },
];

function focused(locator) {
  return locator.evaluate((node) => node === document.activeElement);
}

test("a keyboard user can open a task detail and return to the same board card", async (t) => {
  const page = await openKanban(t, wide, "kanban-task-disclosure", { tasks: [release] });
  await unlock(page);
  const card = page.locator(`[data-native-id="${release.nativeId}"]`);
  await card.waitFor();
  const trigger = card.getByRole("button", { name: release.task.title, exact: true });
  assert.equal(await trigger.count(), 1, "the board task title must be a keyboard-operable disclosure");
  assert.equal(await card.getByRole("form").count(), 0);
  const detailId = await trigger.getAttribute("aria-controls");
  const detail = page.getByRole("dialog", { name: release.task.title });
  await trigger.press("Enter");
  await detail.waitFor();
  await detail.getByText(release.nativeId, { exact: true }).waitFor();
  await detail.getByText(release.task.id, { exact: true }).waitFor();
  await detail.getByText(release.assignee, { exact: true }).waitFor();
  assert.equal(await detail.getAttribute("id"), detailId);
  assert.equal(await focused(detail.getByRole("button", { name: "Close task details" })), true);
  await capture(page, "kanban-task-detail-1280");
  await page.keyboard.press("Escape");
  await detail.waitFor({ state: "hidden" });
  assert.equal(await focused(trigger), true);
});

for (const viewport of [wide, narrow]) {
  test(`native lanes and counts fit ${viewport.width} × ${viewport.height}`, async (t) => {
    const page = await openKanban(t, viewport, `kanban-lanes-${viewport.width}`, { tasks: lanes });
    await unlock(page);
    const board = page.getByRole("region", { name: "Native Hermes board" });
    await board.waitFor();
    for (const [label, status, count] of [
      ["ready", "ready", 2], ["running", "running", 1], ["waiting for review", "waiting_for_review", 1],
      ["blocked", "blocked", 1], ["done", "done", 1],
    ]) {
      const lane = board.getByRole("region", { name: label, exact: true });
      assert.equal(await lane.getAttribute("data-status"), status);
      await lane.getByText(String(count), { exact: true }).waitFor();
      assert.equal(await lane.getByRole("article").count(), count);
    }
    await board.getByText(lanes[1].nativeId, { exact: true }).waitFor();
    await board.getByText("fixture/project#42", { exact: true }).waitFor();
    await board.getByText("Unassigned", { exact: true }).waitFor();
    assert.equal(await board.getByRole("button", { name: lanes[4].task.title }).locator(".title").evaluate((node) =>
      node.clientHeight <= Math.ceil(parseFloat(getComputedStyle(node).lineHeight) * 3)), true);
    assert.equal(await page.getByRole("main").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await board.evaluate((node) => node.scrollWidth > node.clientWidth), viewport.width === narrow.width);
    await capture(page, `kanban-populated-${viewport.width}`);
    if (viewport.width === narrow.width) {
      await board.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.querySelector(".board").scrollLeft > 0);
      for (let index = 0; index < lanes.length; index++) await page.keyboard.press("Tab");
      const last = board.getByRole("button", { name: lanes.at(-1).task.title });
      assert.equal(await focused(last), true);
      await page.keyboard.press("Enter");
      const detail = page.getByRole("dialog", { name: lanes.at(-1).task.title });
      await detail.waitFor();
      assert.equal(await detail.getByText("Assignee", { exact: true }).count(), 0);
      const bounds = await detail.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
      await capture(page, "kanban-task-detail-360");
      await detail.getByRole("button", { name: "Close task details" }).press("Enter");
      await detail.waitFor({ state: "hidden" });
      assert.equal(await focused(last), true);
    }
  });

  test(`empty and unconfigured boards give useful guidance at ${viewport.width} × ${viewport.height}`, async (t) => {
    const empty = await openKanban(t, viewport, `kanban-empty-${viewport.width}`, { tasks: [] });
    await unlock(empty);
    await empty.getByText("No tasks on the selected Hermes board.", { exact: true }).waitFor();
    await empty.getByText("Create or dispatch tasks in Hermes.", { exact: true }).waitFor();
    assert.equal(await empty.getByRole("article").count(), 0);
    await capture(empty, `kanban-empty-${viewport.width}`);

    const setup = await openKanban(t, viewport, `kanban-setup-${viewport.width}`, { tasks: [], setupRequired: true });
    await setup.getByText("Configure the local Hermes board to view its tasks.", { exact: true }).waitFor();
    assert.equal(await setup.getByRole("region", { name: "Native Hermes board" }).count(), 0);
    await capture(setup, `kanban-setup-${viewport.width}`);
  });
}

test("refresh follows the same task across lanes and removal returns focus to the board", async (t) => {
  const page = await openKanban(t, narrow, "kanban-refresh-focus", { tasks: lanes });
  await unlock(page);
  const board = page.getByRole("region", { name: "Native Hermes board" });
  const trigger = board.getByRole("button", { name: release.task.title });
  const detail = page.getByRole("dialog", { name: release.task.title });
  const refresh = detail.getByRole("button", { name: "Refresh board", exact: true });
  await trigger.press("Enter");
  await detail.getByText("ready", { exact: true }).waitFor();
  const moved = [{ ...release, status: "blocked" }, ...lanes.slice(1)];
  await page.evaluate((tasks) => window.kanbanFixture.replaceTasks(tasks), moved);
  await refresh.press("Enter");
  await detail.getByText("blocked", { exact: true }).waitFor();
  assert.equal(await focused(refresh), true);
  await page.keyboard.press("Escape");
  await detail.waitFor({ state: "hidden" });
  assert.equal(await trigger.locator('xpath=ancestor::section[@data-status="blocked"]').count(), 1);
  assert.equal(await focused(trigger), true);

  await trigger.press("Enter");
  await detail.waitFor();
  await page.evaluate((tasks) => window.kanbanFixture.replaceTasks(tasks), lanes.slice(1));
  await refresh.press("Enter");
  await detail.waitFor({ state: "hidden" });
  await page.getByText("The selected task is no longer on the board.", { exact: true }).waitFor();
  assert.equal(await focused(board), true);
  assert.equal(await trigger.count(), 0);
});
