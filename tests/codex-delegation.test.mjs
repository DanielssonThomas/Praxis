import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationalStore } from "@praxis/state";

const taskId = "task_codex_package_fixture";
const sessionId = "session_codex_package_fixture";
const actorId = "principal_codex_manager";
const requestId = "event_codex_scope";
const admissionId = "event_policy_admission_fixture";
const action = { schemaVersion: 1, id: "action_codex_scope", kind: "task.delegate", target: { kind: "task", id: taskId } };
const approval = { schemaVersion: 1, id: "approval_codex_scope", actionId: action.id };
const scopeDigest = "a".repeat(64);
const now = Date.parse("2026-11-26T16:00:00.000Z");

async function module(name) {
  return await import(`../packages/shell/dist/codex-delegation${name}.js`).catch((error) => {
    if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("The packaged host is missing the Codex delegation boundary");
    throw error;
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "praxis-codex-dispatch-"));
  const store = new OperationalStore(join(root, "operational.sqlite"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  store.appendEvent({ schemaVersion: 1, id: requestId, kind: "action.requested", subject: action.target,
    occurredAt: new Date(now).toISOString(), details: { type: "action_request", actorId, action },
  });
  const stage = (name, value) => store.appendEvent({ schemaVersion: 1, id: `event_codex_${name}`, kind: `action.${name}`,
    subject: { kind: "action", id: action.id }, occurredAt: new Date(now).toISOString(), details: {
      type: "action_lifecycle", requestId, actionId: action.id, transition: { stage: name, value },
    },
  });
  return { root, store, stage };
}

test("detached Codex launch requires an exact durable and unexpired operator approval", async (t) => {
  const { store, stage } = await fixture(t);
  const { approvedCodexRequest } = await module("");
  const expiresAt = new Date(now + 10_000).toISOString();
  assert.throws(() => approvedCodexRequest(store, requestId, scopeDigest, now), { code: "invalidated" });
  stage("evaluation", { mode: "approval", approval, scopeDigest, expiresAt });
  assert.throws(() => approvedCodexRequest(store, requestId, scopeDigest, now), { code: "invalidated" });
  stage("decision", { kind: "approve", scopeDigest, approvalId: approval.id });
  assert.throws(() => approvedCodexRequest(store, requestId, "b".repeat(64), now), { code: "invalidated" });
  assert.throws(() => approvedCodexRequest(store, requestId, scopeDigest, now + 10_000), { code: "invalidated" });
  assert.deepEqual(approvedCodexRequest(store, requestId, scopeDigest, now), { requestId, action, actorId });
  stage("settlement", { outcome: "uncertain", reason: "The detached start was not confirmed." });
  assert.throws(() => approvedCodexRequest(store, requestId, scopeDigest, now), { code: "invalidated" });
});

test("a reopened native worker journal retains one exact bounded result and usage receipt", async (t) => {
  const { root } = await fixture(t);
  const { CodexObservationJournal, visibleCodexObservation } = await module("-journal");
  const journal = new CodexObservationJournal(join(root, "observations"));
  const assignment = { schemaVersion: 1, taskId, sessionId, runtime: "codex", runId: "worker_fixture_exact" };
  const snapshot = { schemaVersion: 1, taskId, sessionId, status: "running", output: {
    availability: "available", text: "bounded native output", truncated: false,
  } };
  const usage = { schemaVersion: 1, id: "usage_worker_fixture_exact", sessionId, metering: "reported", inputTokens: 12, outputTokens: 3 };
  const record = { schemaVersion: 1, requestId, admissionId, assignment, observation: { snapshot, usage },
    observedAt: new Date(now).toISOString(), workerRoot: join(root, "worker"),
  };
  await journal.save(record);
  const reopened = new CodexObservationJournal(join(root, "observations"));
  assert.deepEqual(await reopened.get(requestId), record);
  assert.equal(visibleCodexObservation(record, now + 1_000).snapshot.status, "running");
  assert.deepEqual(visibleCodexObservation(record, now + 10_001), { snapshot: { ...snapshot, status: "unknown" }, usage });
  await assert.rejects(journal.save({ ...record, observation: { snapshot: { ...snapshot, sessionId: "session_other" }, usage } }));
  const settled = { ...record, observation: { snapshot: { ...snapshot, status: "completed" }, usage } };
  await journal.save(settled);
  assert.deepEqual(await reopened.list(), [settled]);
  assert.deepEqual(visibleCodexObservation(settled, now + 10_001), settled.observation);
});
