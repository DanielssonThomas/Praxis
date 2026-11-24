import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationalStore, OperationalStoreError } from "@praxis/state";
import { OverviewService } from "../packages/shell/dist/overview-server.js";

const task = { schemaVersion: 1, id: "task_usage_fixture", title: "Check measured usage" };
const session = { schemaVersion: 1, id: "session_usage_fixture", taskId: task.id };
const assignment = { schemaVersion: 1, sessionId: session.id, taskId: task.id, runId: "run_usage_fixture" };
const usage = {
  schemaVersion: 1, id: "usage_runtime_fixture", sessionId: session.id,
  metering: "reported", inputTokens: 0, outputTokens: 0,
};

test("Overview records only reported terminal usage for the verified run and survives local save failures", async (t) => {
  const store = new OperationalStore(":memory:");
  t.after(() => store.close());
  store.recordTask(task);
  store.recordSession(session);
  let snapshot = {
    schemaVersion: 1, taskId: task.id, sessionId: session.id, status: "running",
    output: { availability: "available", text: "Native fixture output", truncated: false },
  };
  let observed = usage;
  const overview = new OverviewService({
    store,
    runtime: {
      inspectLiveAssignment: async (requested) => {
        assert.deepEqual(requested, assignment);
        return { snapshot, usage: observed };
      },
    },
    loadGrants: async () => [{
      principalId: "principal_usage", tokenDigest: "a".repeat(64), actionKinds: [],
      taskIds: [task.id], sessions: [{ sessionId: session.id, assignment, canReport: false }],
    }],
    controls: { view: () => ({ mode: "read_only" }) },
  });
  const inspect = async () => (await overview.list()).panes[0];

  assert.equal((await inspect()).runtime.availability, "available");
  assert.equal(store.getUsage(usage.id), undefined);
  assert.deepEqual(store.eventsFor(usage.id), []);

  snapshot = { ...snapshot, status: "completed" };
  observed = {
    schemaVersion: 1, id: usage.id, sessionId: session.id,
    metering: "unknown", reason: "The native fixture provided no measurements",
  };
  assert.equal((await inspect()).runtime.usage.metering, "unknown");
  assert.equal(store.getUsage(usage.id), undefined);
  assert.deepEqual(store.eventsFor(usage.id), []);

  snapshot = { ...snapshot, sessionId: "session_foreign" };
  observed = usage;
  assert.equal((await inspect()).runtime.availability, "unavailable");
  assert.equal(store.getUsage(usage.id), undefined);

  snapshot = { ...snapshot, sessionId: session.id };
  const persist = store.recordUsageObservation.bind(store);
  store.recordUsageObservation = () => { throw new OperationalStoreError("storage_failure", "Fixture save failure"); };
  const failed = await inspect();
  assert.equal(failed.usageNotice, "Could not save runtime usage to Reports.");
  assert.deepEqual(failed.runtime.snapshot.output, snapshot.output);
  assert.deepEqual(store.eventsFor(usage.id), []);
  store.recordUsageObservation = persist;

  assert.equal((await inspect()).usageNotice, undefined);
  assert.deepEqual(store.getUsage(usage.id), usage);
  const receipts = store.eventsFor(usage.id);
  assert.equal(receipts.length, 1);

  observed = { ...usage, inputTokens: 21 };
  const conflict = await inspect();
  assert.equal(conflict.usageNotice, "A local record conflicts with this Reports measurement.");
  assert.deepEqual(conflict.runtime.usage, observed);
  assert.deepEqual(conflict.runtime.snapshot.output, snapshot.output);
  assert.deepEqual(store.getUsage(usage.id), usage);
  assert.deepEqual(store.eventsFor(usage.id), receipts);
});
