import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopBrowserSuite } from "../../shell/desktop-browser-fixture.mjs";

const { open, capture } = desktopBrowserSuite();
const requestId = "event_fixture_stop";
const approvalId = "approval_fixture_stop";

function installActivityFixture() {
  window.isTauri = true;
  window.activityFixture = {
    unlocked: false,
    decisions: [],
    feed: [],
  };
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      const fixture = window.activityFixture;
      switch (command) {
        case "host_status": return { stage: "ready", nodeVersion: "24.22.3" };
        case "unlock_activity":
          fixture.unlocked = true;
          return structuredClone(fixture.feed);
        case "lock_activity":
          fixture.unlocked = false;
          return null;
        case "read_activity":
          if (fixture.unlocked) return structuredClone(fixture.feed);
          throw { code: "locked", message: "Unlock activity first." };
        case "decide_activity": {
          const { request } = args;
          fixture.decisions.push(structuredClone(request));
          const card = fixture.feed.find((entry) => entry.requestId === request.requestId);
          if (card?.phase.state !== "attention" || card.phase.approval.id !== request.approvalId) {
            throw { code: "conflict", message: "This approval no longer matches the reviewed action." };
          }
          const status = card.action.kind === "task.delegate" ? "running" : "stopping";
          card.phase = request.decision === "deny" ? { state: "denied" }
            : { state: "resolved", native: { status } };
          return structuredClone(card);
        }
        default:
          throw new Error("Unexpected synthetic IPC command " + command);
      }
    },
  };
}

function pending(id = approvalId) {
  return {
    requestId,
    actorId: "principal_fixture_worker",
    action: { kind: "session.stop", target: { kind: "session", id: "session_fixture_worker" } },
    phase: { state: "attention", approval: { id }, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() },
  };
}

async function setFeed(page, ...cards) {
  await page.evaluate((feed) => { window.activityFixture.feed = feed; }, cards);
}

async function decisions(page) {
  return page.evaluate(() => window.activityFixture.decisions);
}

function activity(page) {
  return page.getByRole("button", { name: "Activity", exact: true });
}

function inbox(page) {
  return page.getByRole("complementary", { name: "Activity", exact: true });
}

async function unlock(page) {
  await activity(page).press("Enter");
  const form = inbox(page).getByRole("form", { name: "Unlock activity" });
  await form.getByLabel("Operator token").fill("synthetic-browser-fixture");
  await form.getByRole("button", { name: "Unlock activity" }).click();
  await form.waitFor({ state: "hidden" });
}

async function assertFocus(locator) {
  assert.equal(await locator.evaluate((node) => node === document.activeElement), true);
}

async function openActivity(t, viewport, observation) {
  return open(t, viewport, observation, "#/manager", { initialize: installActivityFixture });
}

test("Activity identifies delegated Codex work in review and after approval", async (t) => {
  const page = await openActivity(t, { width: 1120, height: 760 }, "activity-codex-delegation");
  const card = { ...pending(), action: { kind: "task.delegate", target: { kind: "task", id: "task_fixture_codex" } } };
  await setFeed(page, card);
  await unlock(page);
  const review = inbox(page).getByRole("button", { name: "Review", exact: true });
  await review.waitFor();
  assert.equal(await inbox(page).getByText("Delegate task to Codex", { exact: true }).count(), 1);
  await review.click();
  const dialog = page.getByRole("dialog", { name: "Review request", exact: true });
  await dialog.getByText(card.action.target.id, { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Approve once" }).click();
  await dialog.getByText("Codex reported the run as running.", { exact: true }).waitFor();
  assert.deepEqual(await decisions(page), [{ requestId, approvalId, decision: "approve" }]);
});

test("closed Activity announces newly pending approvals across routes and clears them on lock", async (t) => {
  const page = await openActivity(t, { width: 360, height: 620 }, "activity-closed-feed-360");
  await unlock(page);
  await activity(page).press("Enter");
  await inbox(page).waitFor({ state: "hidden" });
  const field = page.getByRole("textbox", { name: "Command" });
  await field.fill("/o");
  await field.press("Enter");
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await setFeed(page, pending());
  await page.getByText("1 pending approval", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await activity(page).getAttribute("aria-expanded"), "false");
  assert.equal(await activity(page).evaluate((node) => (
    document.getElementById(node.getAttribute("aria-describedby"))?.textContent.trim()
  )), "1 pending approval");
  await capture(page, "activity-pending-360");

  await activity(page).press("Enter");
  await inbox(page).getByRole("heading", { name: "Activity", exact: true }).waitFor();
  await assertFocus(inbox(page).getByRole("heading", { name: "Activity", exact: true }));
  await page.keyboard.press("Escape");
  await inbox(page).waitFor({ state: "hidden" });
  await assertFocus(activity(page));

  await activity(page).press("Enter");
  await inbox(page).getByRole("button", { name: "Lock activity" }).click();
  await inbox(page).getByRole("form", { name: "Unlock activity" }).waitFor();
  assert.equal(await activity(page).getAttribute("aria-describedby"), null);
  assert.equal(await page.getByText("principal_fixture_worker", { exact: true }).count(), 0);
});

for (const [viewport, decision] of [[{ width: 1280, height: 800 }, "approve"], [{ width: 360, height: 620 }, "deny"]]) {
  test("exact Activity review and keyboard dismissal at " + viewport.width + " × " + viewport.height, async (t) => {
    const page = await openActivity(t, viewport, "activity-review-" + viewport.width);
    const card = pending();
    await setFeed(page, card);
    await unlock(page);
    const review = inbox(page).getByRole("button", { name: "Review", exact: true });
    assert.equal(await inbox(page).getByRole("button", { name: "Approve once" }).count(), 0);
    assert.equal(await inbox(page).getByRole("button", { name: "Deny" }).count(), 0);
    await review.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Review request", exact: true });
    const close = dialog.getByRole("button", { name: "Close review" });
    const approve = dialog.getByRole("button", { name: "Approve once" });
    const deny = dialog.getByRole("button", { name: "Deny" });
    await dialog.waitFor();
    for (const text of ["session.stop", "session_fixture_worker", "principal_fixture_worker"]) {
      await dialog.getByText(text, { exact: true }).waitFor();
    }
    assert.equal(await dialog.locator("time").getAttribute("datetime"), card.phase.expiresAt);
    await assertFocus(close);
    assert.equal(await close.evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
    await page.keyboard.press("Tab");
    await assertFocus(approve);
    await page.keyboard.press("Tab");
    await assertFocus(deny);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), true);
    assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    await capture(page, "activity-review-" + viewport.width);
    assert.deepEqual(await decisions(page), []);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await assertFocus(review);
    await inbox(page).getByText("Needs attention", { exact: true }).waitFor();
    assert.deepEqual(await decisions(page), []);

    await review.press("Enter");
    await (decision === "approve" ? approve : deny).press("Enter");
    const lifecycle = decision === "approve" ? "Stop requested. Hermes has yet to report a settled stop." : "Denied";
    await dialog.getByText(lifecycle, { exact: true }).waitFor();
    assert.deepEqual(await decisions(page), [{ requestId, approvalId, decision }]);
    assert.equal(await approve.isDisabled(), true);
    assert.equal(await deny.isDisabled(), true);
    await capture(page, "activity-decision-" + viewport.width);
    await close.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    await assertFocus(inbox(page).locator("article"));
  });
}

test("a refreshed replacement and durable terminal states disable stale Activity decisions", async (t) => {
  const page = await openActivity(t, { width: 1280, height: 800 }, "activity-updated-review");
  const original = pending();
  await setFeed(page, original);
  await unlock(page);
  const review = inbox(page).getByRole("button", { name: "Review", exact: true });
  const dialog = page.getByRole("dialog", { name: "Review request", exact: true });
  await review.press("Enter");
  assert.equal(await dialog.getByRole("button", { name: "Approve once" }).isEnabled(), true);
  const replacement = pending("approval_fixture_replacement");
  await setFeed(page, replacement);
  await dialog.getByText("Approval details changed. Close this review and open the current request.").waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Approve once" }).isDisabled(), true);
  assert.deepEqual(await decisions(page), []);
  await dialog.getByRole("button", { name: "Close review" }).press("Enter");
  await review.press("Enter");
  assert.equal(await dialog.getByRole("button", { name: "Approve once" }).isEnabled(), true);

  const expired = { ...replacement, phase: { state: "expired", reason: "The approval expired." } };
  await setFeed(page, expired);
  await dialog.getByText("Expired", { exact: true }).waitFor();
  await dialog.getByText("The approval expired.", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Deny" }).isDisabled(), true);
  await capture(page, "activity-expired-review");
  await dialog.getByRole("button", { name: "Close review" }).press("Enter");

  await setFeed(page, expired,
    { ...original, requestId: "event_fixture_invalidated", phase: { state: "invalidated", reason: "The native assignment changed." } },
    { ...original, requestId: "event_fixture_uncertain", phase: { state: "uncertain", reason: "Hermes did not verify execution." } },
  );
  await inbox(page).getByText("Invalidated", { exact: true }).waitFor();
  await inbox(page).getByText("Execution unverified", { exact: true }).waitFor();
  assert.equal(await inbox(page).getByRole("button", { name: "Review", exact: true }).count(), 0);
  assert.deepEqual(await decisions(page), []);
});

test("the deadline disables both decisions before the authoritative phase catches up", async (t) => {
  const page = await openActivity(t, { width: 360, height: 620 }, "activity-review-deadline");
  const card = pending();
  await setFeed(page, card);
  await unlock(page);
  await inbox(page).getByRole("button", { name: "Review", exact: true }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Review request", exact: true });
  const approve = dialog.getByRole("button", { name: "Approve once" });
  const deny = dialog.getByRole("button", { name: "Deny" });
  assert.equal(await approve.isEnabled(), true);
  await page.clock.setFixedTime(new Date(Date.parse(card.phase.expiresAt) + 1));
  await dialog.getByText("The approval deadline passed.").waitFor();
  assert.equal(await approve.isDisabled(), true);
  assert.equal(await deny.isDisabled(), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await assertFocus(inbox(page).getByRole("button", { name: "Review", exact: true }));
  assert.equal(await activity(page).getAttribute("aria-describedby"), null);
  assert.deepEqual(await decisions(page), []);
});
