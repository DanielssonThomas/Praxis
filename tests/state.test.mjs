import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { OperationalStore } from "@praxis/state";

const execute = promisify(execFile);
const childWriter = `
  import { OperationalStore } from "@praxis/state";
  const [path, entries] = process.argv.slice(1);
  const store = new OperationalStore(path);
  try {
    const results = JSON.parse(entries).map(([method, ...args]) => store[method](...args));
    process.stdout.write(JSON.stringify(results));
  } finally {
    store.close();
  }
`;

async function writeInNewProcess(path, entries) {
  const { stdout } = await execute(process.execPath, [
    "--input-type=module", "--eval", childWriter, path, JSON.stringify(entries),
  ], { timeout: 15_000 });
  return JSON.parse(stdout);
}

const task = { schemaVersion: 1, id: "task_1", title: "Check the local build" };
const session = { schemaVersion: 1, id: "session_2", taskId: task.id };
const event = {
  schemaVersion: 1,
  id: "event_3",
  kind: "task.failed",
  occurredAt: "2026-07-28T10:30:00Z",
  subject: { kind: "task", id: task.id },
};
const unavailableUsage = {
  schemaVersion: 1,
  id: "usage_4",
  sessionId: session.id,
  metering: "unknown",
  reason: "The native session did not report usage",
};
const reportedUsage = {
  schemaVersion: 1,
  id: "usage_5",
  sessionId: session.id,
  metering: "reported",
  inputTokens: 0,
};

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "praxis-state-"));
  const path = join(directory, "operational.sqlite");
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    path,
    open() {
      const store = new OperationalStore(path);
      stores.push(store);
      return store;
    },
  };
}

test("task, session, failed event and usage records survive the writer process exiting", async (t) => {
  const database = fixture(t);
  assert.deepEqual(await writeInNewProcess(database.path, [
    ["recordTask", task],
    ["recordSession", session],
    ["appendEvent", event],
    ["recordUsage", unavailableUsage],
    ["recordUsage", reportedUsage],
  ]), Array(5).fill("inserted"));

  const reopened = database.open();
  assert.deepEqual(reopened.getTask(task.id), task);
  assert.deepEqual(reopened.getSession(session.id), session);
  assert.deepEqual(reopened.getEvent(event.id), event);
  assert.deepEqual(reopened.getUsage(unavailableUsage.id), unavailableUsage);
  assert.deepEqual(reopened.getUsage(reportedUsage.id), reportedUsage);
  assert.equal(reopened.getTask("task_missing"), undefined);
});

test("different connections deduplicate replay and preserve the original on ID collisions", (t) => {
  const database = fixture(t);
  const writer = database.open();
  const replayer = database.open();
  writer.recordTask(task);
  writer.recordSession(session);
  assert.equal(writer.appendEvent(event), "inserted");
  assert.equal(replayer.appendEvent({
    subject: { id: event.subject.id, kind: event.subject.kind },
    occurredAt: event.occurredAt,
    kind: event.kind,
    id: event.id,
    schemaVersion: 1,
  }), "duplicate");
  assert.throws(() => replayer.appendEvent({ ...event, kind: "task.completed" }), { code: "identity_conflict" });
  assert.deepEqual(replayer.eventsFor(task.id), [event]);
  assert.deepEqual(replayer.eventsFor(session.id), []);

  assert.equal(writer.recordUsage(reportedUsage), "inserted");
  assert.equal(replayer.recordUsage(reportedUsage), "duplicate");
  assert.throws(() => replayer.recordUsage({ ...reportedUsage, inputTokens: 3 }), { code: "identity_conflict" });
  assert.deepEqual(writer.getUsage(reportedUsage.id), reportedUsage);
});

test("concurrent writer processes converge on one durable event", async (t) => {
  const database = fixture(t);
  const entries = [["appendEvent", event]];
  const writes = await Promise.all([
    writeInNewProcess(database.path, entries),
    writeInNewProcess(database.path, entries),
  ]);

  assert.deepEqual(writes.flat().sort(), ["duplicate", "inserted"]);
  assert.deepEqual(database.open().eventsFor(task.id), [event]);
});

test("concurrent terminal observations persist one measured zero with the first receipt time", async (t) => {
  const database = fixture(t);
  const writer = database.open();
  writer.recordTask(task);
  writer.recordSession(session);
  const times = ["2026-07-28T10:30:00Z", "2026-07-28T10:31:00Z"];
  const results = await Promise.all(times.map((time) => writeInNewProcess(database.path, [
    ["recordUsageObservation", reportedUsage, time],
  ])));
  const reopened = database.open();
  assert.deepEqual(results.flat().sort(), ["duplicate", "inserted"]);
  const [observed] = reopened.eventsFor(reportedUsage.id);
  assert.equal(reopened.eventsFor(reportedUsage.id).length, 1);
  assert.equal(observed.kind, "usage.observed");
  assert.equal(observed.occurredAt, times[results.findIndex(([result]) => result === "inserted")]);
  assert.deepEqual(reopened.getUsage(reportedUsage.id), reportedUsage);
  assert.equal(reopened.recordUsageObservation(reportedUsage, "2026-07-28T10:32:00Z"), "duplicate");
  assert.deepEqual(reopened.eventsFor(reportedUsage.id), [observed]);
  assert.throws(() => reopened.recordUsageObservation(unavailableUsage, event.occurredAt), { code: "invalid_record" });
  assert.equal(reopened.getUsage(unavailableUsage.id), undefined);
});

test("terminal observations reuse older usage and receipt records without partial writes on conflict", (t) => {
  const database = fixture(t);
  const writer = database.open();
  writer.recordTask(task);
  writer.recordSession(session);
  writer.recordUsage(reportedUsage);
  assert.equal(writer.recordUsageObservation(reportedUsage, event.occurredAt), "inserted");
  const [observed] = writer.eventsFor(reportedUsage.id);
  assert.throws(() => writer.recordUsageObservation({ ...reportedUsage, inputTokens: 1 }, event.occurredAt), {
    code: "identity_conflict",
  });
  assert.deepEqual(writer.getUsage(reportedUsage.id), reportedUsage);
  assert.deepEqual(writer.eventsFor(reportedUsage.id), [observed]);

  const legacyUsage = { ...reportedUsage, id: "usage_legacy" };
  const legacy = {
    ...event, id: "event_old_receipt", kind: "usage.observed", subject: { kind: "usage", id: legacyUsage.id },
  };
  writer.recordUsage(legacyUsage);
  writer.appendEvent(legacy);
  assert.equal(writer.recordUsageObservation(legacyUsage, "2026-07-29T10:30:00Z"), "duplicate");
  assert.deepEqual(writer.eventsFor(legacyUsage.id), [legacy]);

  const blocked = fixture(t).open();
  blocked.recordTask(task);
  blocked.recordSession(session);
  blocked.appendEvent({ ...event, id: observed.id });
  assert.throws(() => blocked.recordUsageObservation(reportedUsage, event.occurredAt), { code: "identity_conflict" });
  assert.equal(blocked.getUsage(reportedUsage.id), undefined, "a failed receipt rolls back the new measurement");
  assert.deepEqual(blocked.eventsFor(reportedUsage.id), []);
});

test("rejected records and unavailable storage surface explicit failures without partial writes", (t) => {
  const database = fixture(t);
  const store = database.open();
  assert.throws(() => store.recordTask({ ...task, schemaVersion: 2 }), { code: "invalid_record" });
  assert.throws(() => store.recordSession(session), { code: "missing_reference" });
  assert.throws(() => store.recordUsage(reportedUsage), { code: "missing_reference" });
  assert.equal(store.getTask(task.id), undefined);
  assert.equal(store.getSession(session.id), undefined);
  assert.equal(store.getUsage(reportedUsage.id), undefined);

  const notDirectory = join(database.directory, "file");
  writeFileSync(notDirectory, "fixture");
  assert.throws(() => new OperationalStore(join(notDirectory, "state.sqlite")), { code: "storage_failure" });
});

test("a database from an unsupported schema version is left untouched", (t) => {
  const database = fixture(t);
  const unsupported = new DatabaseSync(database.path);
  unsupported.exec("PRAGMA user_version = 99");
  unsupported.close();
  assert.throws(() => database.open(), { code: "unsupported_version" });
  const inspected = new DatabaseSync(database.path);
  assert.equal(inspected.prepare("PRAGMA user_version").get().user_version, 99);
  inspected.close();
});
