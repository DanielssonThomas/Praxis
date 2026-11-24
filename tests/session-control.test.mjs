import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HermesRuntimeError } from "@praxis/hermes-runtime";
import { OperationalStore } from "@praxis/state";

const session = { schemaVersion: 1, id: "session_control", taskId: "task_control" };
const assignment = { schemaVersion: 1, sessionId: session.id, taskId: session.taskId, runId: "run_control" };
const command = (operation, fields = {}) => ({ operation, sessionId: session.id, ...fields });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "praxis-session-control-"));
  const database = join(directory, "state.sqlite");
  const store = new OperationalStore(database);
  const second = new OperationalStore(database);
  store.recordTask({ schemaVersion: 1, id: session.taskId, title: "Inspect session control fixture" });
  store.recordSession(session);
  t.after(async () => {
    store.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, second };
}

test("exclusive session control is visible across SQLite connections and uses exact compare-and-set", async (t) => {
  const { store, second } = await fixture(t);
  assert.equal(store.sessionControl(session.id), undefined);
  const automated = { mode: "automated_write", revision: randomUUID(), actionId: "action_automated" };
  assert.equal(store.compareSessionControl(session.id, undefined, automated), true);
  assert.deepEqual(second.sessionControl(session.id), automated);
  assert.equal(second.compareSessionControl(session.id, undefined, automated), false);
  assert.equal(second.compareSessionControl(session.id, randomUUID(), undefined), false);
  assert.equal(second.compareSessionControl(session.id, automated.revision, undefined), true);
  assert.equal(store.sessionControl(session.id), undefined);
});

test("an existing claim rolls back the automated fence atomically", async (t) => {
  const { store, second } = await fixture(t);
  const event = {
    schemaVersion: 1, id: "event_existing_control", kind: "action.decision",
    subject: { kind: "action", id: "action_existing_control" }, occurredAt: "2026-09-20T10:00:00Z",
  };
  store.appendEvent(event);
  const automated = { mode: "automated_write", revision: randomUUID(), actionId: event.subject.id };
  assert.throws(() => second.compareSessionControl(session.id, undefined, automated, event), { code: "identity_conflict" });
  assert.equal(store.sessionControl(session.id), undefined);
});

test("manual input requires explicit takeover and remains fenced until exact native guidance is reconciled", async (t) => {
  const { SessionControlService } = await import("../packages/shell/dist/session-control.js");
  const { store, second } = await fixture(t);
  let enabled = true;
  let proved = false;
  let calls = 0;
  const control = new SessionControlService({
    store,
    loadBinding: async (id) => id === session.id ? { assignment, enabled } : undefined,
    runtime: {
      guidanceReady: async () => true,
      guidanceBaseline: async () => 23,
      steerAssignment: async (native, text, authorize) => {
        await authorize();
        assert.deepEqual(native, assignment);
        assert.equal(text, "Check the fixture notes");
        calls++;
      },
      reconcileGuidance: async (native, after, digest) => {
        assert.deepEqual(native, assignment);
        assert.equal(after, 23);
        assert.match(digest, /^[a-f0-9]{64}$/);
        return proved ? "delivered" : undefined;
      },
    },
  });
  await assert.rejects(control.operate(command("guide", { text: "Check the fixture notes" })), { status: 409 });
  assert.equal((await control.operate(command("takeover"))).mode, "manual");
  assert.equal((await control.operate(command("guide", { text: "Check the fixture notes" }))).guidance, "pending");
  assert.equal(second.sessionControl(session.id).mode, "manual");
  assert.equal(calls, 1);
  await assert.rejects(control.operate(command("return")), { status: 409 });
  await assert.rejects(control.operate(command("guide", { text: "Check the fixture notes" })), { status: 409 });
  assert.equal(calls, 1);
  enabled = false;
  await assert.rejects(control.operate(command("guide", { text: "Check the fixture notes" })), { status: 403 });
  proved = true;
  assert.equal((await control.operate(command("return"))).guidance, "delivered");
  assert.equal(second.sessionControl(session.id), undefined);
});

test("an uncertain native steer remains fenced across a service restart and is never sent twice", async (t) => {
  const { SessionControlService } = await import("../packages/shell/dist/session-control.js");
  const { store, second } = await fixture(t);
  let calls = 0;
  const loadBinding = async () => ({ assignment, enabled: true });
  const runtime = {
    guidanceReady: async () => true,
    guidanceBaseline: async () => 1,
    steerAssignment: async (_assignment, _text, authorize) => {
      await authorize();
      calls++;
      throw new HermesRuntimeError("unavailable", "The native receipt was lost.");
    },
    reconcileGuidance: async () => undefined,
  };
  const control = new SessionControlService({ store, runtime, loadBinding });
  await control.operate(command("takeover"));
  const guide = command("guide", { text: "Summarize the fixture" });
  await assert.rejects(control.operate(guide), { status: 409, message: /outcome is uncertain/ });
  assert.equal(second.sessionControl(session.id).pending.outcome, "uncertain");
  const restarted = new SessionControlService({ store: second, runtime, loadBinding });
  await assert.rejects(restarted.operate(guide), { status: 409, message: /native transcript/ });
  await assert.rejects(restarted.operate(command("return")), { status: 409, message: /native transcript/ });
  assert.equal(calls, 1);
});
