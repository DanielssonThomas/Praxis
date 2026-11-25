import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationalStore } from "@praxis/state";

const task = { schemaVersion: 1, id: "task_manage", title: "Review fixture" };
function item(name, kind = "maintenance") {
  return { id: `event_${name}`, taskId: task.id, kind, instruction: name };
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "praxis-management-"));
  const db = join(dir, "state.sqlite");
  const a = new OperationalStore(db);
  const b = new OperationalStore(db);
  a.recordTask(task);
  t.after(async () => { a.close(); b.close(); await rm(dir, { recursive: true, force: true }); });
  return { a, b };
}

test("durable priority and bounded claims survive a second connection without duplicate admission", async (t) => {
  const { a, b } = await fixture(t);
  assert.equal(a.management.enqueue(item("routine"), 1), "inserted");
  assert.equal(a.management.enqueue(item("direction", "direction"), 2), "inserted");
  assert.equal(b.management.enqueue(item("direction", "direction"), 3), "duplicate");
  const [first] = a.management.claim(1, 5, 100);
  assert.equal(first.work.id, "event_direction");
  assert.deepEqual(b.management.claim(1, 6, 100), []);
  const [reopened] = b.management.claim(1, 105, 100);
  assert.equal(reopened.work.id, first.work.id);
  assert.equal(reopened.attempt, first.attempt);
  assert.equal(reopened.startedAt, first.startedAt);
  assert.notEqual(reopened.claim, first.claim);
  assert.equal(a.management.update(first, { state: "completed", availableAt: 110 }), false);
  assert.equal(b.management.update(reopened, { state: "completed", availableAt: 110 }), true);
  assert.equal(a.management.claim(1, 110, 100)[0].work.id, "event_routine");
});

const grant = {
  principalId: "principal_background_fixture", tokenDigest: "a".repeat(64),
  taskIds: [task.id], sessions: [], actionKinds: [],
};
function fake() {
  const submissions = [];
  const runs = new Map();
  let lose = false;
  let fail = false;
  let unavailable = false;
  const snapshot = ({ taskId, sessionId }) => ({
    schemaVersion: 1, taskId, sessionId, status: fail ? "failed" : "completed",
    output: { availability: "available", text: "Native advisory output", truncated: false },
  });
  return {
    submissions, runs,
    loseNext() { lose = true; },
    fail() { fail = true; },
    unavailable() { unavailable = true; },
    async submitTurn(session, prompt, key) {
      submissions.push({ session, prompt, key });
      if (!runs.has(key)) {
        runs.set(key, { schemaVersion: 1, taskId: session.taskId, sessionId: session.id, runId: `run_fixture_${runs.size + 1}` });
      }
      if (lose) { lose = false; throw new Error("Native submission acknowledgement was lost."); }
      return runs.get(key);
    },
    async inspectAssignment(assignment) {
      if (unavailable) throw new Error("Unavailable native inspection.");
      return snapshot(assignment);
    },
    async inspectLiveAssignment(assignment) {
      return {
        snapshot: snapshot(assignment),
        usage: {
          schemaVersion: 1, id: `usage_${assignment.runId}`, sessionId: assignment.sessionId,
          metering: "reported", inputTokens: 0, outputTokens: 3,
        },
      };
    },
  };
}
async function coordinator(store, runtime, clock, maxAttempts = 2) {
  const { ManagementService } = await import("@praxis/management");
  return new ManagementService({
    store, runtime, profile: "native-background", principalId: grant.principalId, loadGrant: async () => grant,
    concurrency: 1, maxAttempts, pollMs: 1, now: () => clock.now,
  });
}
async function ticks(service, clock, count) {
  for (let index = 0; index < count; index++) { clock.now += 100; await service.advance(); }
}

test("a lost receipt after a native claim reuses the same turn after restart and records usage once", async (t) => {
  const { a, b } = await fixture(t);
  const clock = { now: 10_000 };
  const runtime = fake();
  runtime.loseNext();
  const before = await coordinator(a, runtime, clock);
  const source = { schemaVersion: 1, id: "session_reporter", taskId: task.id };
  a.recordSession(source);
  a.appendEvent({
    schemaVersion: 1, id: "event_worker_question", kind: "worker.question", occurredAt: "2026-09-24T00:00:00Z",
    subject: { kind: "session", id: source.id },
    details: { type: "worker_report", actorId: "principal_worker", message: "Which criterion should I use?" },
  });
  await ticks(before, clock, 1);
  assert.equal(runtime.runs.size, 1);
  assert.equal(a.management.list()[0].runId, undefined);
  const restarted = await coordinator(b, runtime, clock);
  await ticks(restarted, clock, 3);
  assert.equal(runtime.runs.size, 1);
  assert.equal(runtime.submissions.length, 2);
  assert.deepEqual(runtime.submissions[0], runtime.submissions[1]);
  assert.notEqual(a.management.list()[0].session.id, source.id);
  assert.equal(a.management.list()[0].result.text, "Native advisory output");
  assert.equal(a.eventsOfKind("management.completed").length, 1);
  const [meter] = a.eventsOfKind("management.usage");
  assert.equal(a.getUsage(meter.subject.id).inputTokens, 0);
  assert.deepEqual(a.eventsOfKind("usage.observed"), []);
});

test("known failures retry new turns within limits and escalate to the ordinary Activity list", async (t) => {
  const { a } = await fixture(t);
  const clock = { now: 10_000 };
  const runtime = fake();
  runtime.fail();
  const service = await coordinator(a, runtime, clock);
  await service.enqueue(item("repeat", "direction"));
  await ticks(service, clock, 6);
  const [work] = a.management.list();
  assert.equal(work.attempt, 2);
  assert.equal(work.state, "escalated");
  assert.equal(runtime.runs.size, 2);
  assert.equal(runtime.submissions[0].session.id, runtime.submissions[1].session.id);
  assert.notEqual(runtime.submissions[0].key, runtime.submissions[1].key);
  assert.equal(a.eventsOfKind("management.usage").length, 2);
  assert.equal(a.eventsOfKind("management.escalated").length, 1);
  const { ApprovalService } = await import("@praxis/approvals");
  const approval = new ApprovalService({ store: a, loadGrants: async () => [grant], runtime });
  const [activity] = await approval.list();
  assert.equal(activity.state, "escalated");
  assert.equal(activity.action.target.id, task.id);
  await assert.rejects(approval.inspect(activity.requestId), { code: "not_found" });
  assert.deepEqual(a.eventsOfKind("action.requested"), []);
});

test("an uncertain active outcome holds its slot and does not start routine work", async (t) => {
  const { a } = await fixture(t);
  const clock = { now: 10_000 };
  const runtime = fake();
  runtime.unavailable();
  const service = await coordinator(a, runtime, clock);
  await service.enqueue(item("priority", "direction"));
  await service.enqueue(item("routine"));
  await ticks(service, clock, 6);
  assert.equal(runtime.runs.size, 1);
  assert.deepEqual(a.management.list().map(({ state }) => state), ["held", "queued"]);
  assert.equal(a.eventsOfKind("management.escalated").length, 1);
});
