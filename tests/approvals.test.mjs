import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ApprovalService } from "@praxis/approvals";
import { HermesRuntimeError } from "@praxis/hermes-runtime";
import { OperationalStore } from "@praxis/state";

const task = { schemaVersion: 1, id: "task_approval", title: "Scoped Runtime Fixture" };
const session = { schemaVersion: 1, id: "session_approval", taskId: task.id };
const assignment = { schemaVersion: 1, taskId: task.id, sessionId: session.id, runId: "run_approval" };
const actor = "principal_fixture";
const execute = promisify(execFile);

function fixture(t, settings = {}) {
  const directory = mkdtempSync(join(tmpdir(), "praxis-approvals-"));
  const database = join(directory, "state.sqlite");
  const stores = [];
  function open() {
    const store = new OperationalStore(database);
    stores.push(store);
    return store;
  }
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const store = open();
  store.recordTask(task);
  store.recordSession(session);
  const grants = [{
    principalId: actor,
    tokenDigest: "1".repeat(64),
    taskIds: [task.id],
    sessions: [{ sessionId: session.id, canReport: true, assignment: { ...assignment } }],
    actionKinds: ["session.inspect", "session.stop"],
  }];
  const time = { now: Date.parse("2026-07-28T10:30:00Z") };
  const calls = [];
  const native = (status) => ({
    schemaVersion: 1, taskId: task.id, sessionId: session.id, status,
    output: { availability: "unavailable", reason: "Fixture did not publish output" },
  });
  function service(databaseStore = store) {
    return new ApprovalService({
      store: databaseStore,
      loadGrants: async () => grants,
      now: () => time.now,
      taskDelegation: settings.taskDelegation,
      runtime: {
        async inspectAssignment(reference) {
          calls.push({ method: "inspect", reference });
          return native("running");
        },
        async stopAssignment(reference, authorize) {
          settings.beforeStop?.();
          await authorize();
          calls.push({ method: "stop", reference });
          if (settings.stop) await settings.stop();
          return native("stopping");
        },
      },
    });
  }
  function request(id, kind = "session.stop", target = { kind: "session", id: session.id }) {
    const event = {
      schemaVersion: 1,
      id: `event_request_${id}`,
      kind: "action.requested",
      subject: target,
      occurredAt: "2030-01-01T00:00:00Z",
      details: {
        type: "action_request",
        actorId: actor,
        action: { schemaVersion: 1, id: `action_${id}`, kind, target },
      },
    };
    store.appendEvent(event);
    return event;
  }
  return { calls, database, directory, grants, open, request, service, time };
}

function decision(activity, value = "approve") {
  return { requestId: activity.requestId, approvalId: activity.approval.id, decision: value };
}

test("a restricted card retains its request identity from processing to attention and invokes one exact action", async (t) => {
  const { service, request, calls, time } = fixture(t);
  const approval = service();
  const proposed = request("one");
  const [processing] = await approval.list();
  assert.equal(processing.state, "processing");
  assert.equal(processing.requestId, proposed.id);
  assert.deepEqual(calls, []);

  const attention = await approval.inspect(proposed.id);
  assert.equal(attention.state, "attention");
  assert.equal(attention.requestId, proposed.id);
  assert.deepEqual(attention.action, proposed.details.action);
  assert.equal(attention.approval.actionId, attention.action.id);
  assert.ok(Date.parse(attention.expiresAt) > time.now);
  assert.ok(Date.parse(attention.expiresAt) < Date.parse(proposed.occurredAt));
  await assert.rejects(approval.decide({ ...decision(attention), approvalId: "approval_other" }), { code: "invalid_approval" });
  assert.deepEqual(calls, []);

  const result = await approval.decide(decision(attention));
  assert.equal(result.state, "resolved");
  assert.equal(result.native.status, "stopping");
  assert.deepEqual(calls, [{ method: "stop", reference: assignment }]);
  await assert.rejects(approval.decide(decision(attention)), { code: "already_decided" });
  assert.equal(calls.length, 1);
});

test("denial, expired approval and live grant replacement cannot execute native stop", async (t) => {
  const { service, request, calls, grants, time } = fixture(t);
  const approval = service();
  const denied = await approval.inspect(request("denied").id);
  assert.equal((await approval.decide(decision(denied, "deny"))).state, "denied");
  await assert.rejects(approval.decide(decision(denied)), { code: "already_decided" });

  const expiring = await approval.inspect(request("expired").id);
  time.now = Date.parse(expiring.expiresAt);
  await assert.rejects(approval.decide(decision(expiring)), { code: "expired" });

  const stale = await approval.inspect(request("changed").id);
  grants[0].sessions[0].assignment.runId = "run_replacement";
  const states = new Map((await approval.list()).map(({ requestId, state }) => [requestId, state]));
  assert.equal(states.get(expiring.requestId), "expired");
  assert.equal(states.get(stale.requestId), "invalidated");
  grants[0].sessions[0].assignment.runId = assignment.runId;
  await assert.rejects(approval.decide(decision(stale)), { code: "invalidated" });
  assert.deepEqual(calls, []);
});

test("an exact task delegation approval launches once and denies stale or refused requests", async (t) => {
  let scope = "a".repeat(64);
  const delegated = [];
  const native = {
    schemaVersion: 1, taskId: task.id, sessionId: session.id, status: "running",
    output: { availability: "unavailable", reason: "The worker has started." },
  };
  const { service, request, grants, open, calls } = fixture(t, {
    taskDelegation: {
      async preview(item) {
        assert.equal(item.actorId, actor);
        assert.deepEqual(item.action.target, { kind: "task", id: task.id });
        return scope;
      },
      async execute(item, fingerprint) {
        delegated.push({ requestId: item.requestId, fingerprint });
        return native;
      },
    },
  });
  grants[0].actionKinds.push("task.delegate");
  const taskRequest = (id) => request(id, "task.delegate", { kind: "task", id: task.id });
  const approval = service();
  const allowed = taskRequest("task_allow");
  const attention = await approval.inspect(allowed.id);
  assert.equal(attention.state, "attention");
  assert.deepEqual(delegated, []);
  const outcome = await approval.decide(decision(attention));
  assert.equal(outcome.state, "resolved");
  assert.deepEqual(outcome.native, native);
  await assert.rejects(service(open()).decide(decision(attention)), { code: "already_decided" });

  const denied = await approval.inspect(taskRequest("task_deny").id);
  assert.equal((await approval.decide(decision(denied, "deny"))).state, "denied");
  const stale = await approval.inspect(taskRequest("task_stale").id);
  scope = "b".repeat(64);
  await assert.rejects(approval.decide(decision(stale)), { code: "invalidated" });
  grants[0].actionKinds.pop();
  assert.equal((await approval.inspect(taskRequest("no_task_grant").id)).state, "refused");
  assert.deepEqual(delegated, [{ requestId: allowed.id, fingerprint: "a".repeat(64) }]);
  assert.deepEqual(calls, []);
});

test("a scope change at the native execution boundary invalidates a claimed approval", async (t) => {
  const sandbox = fixture(t, {
    beforeStop() { sandbox.grants[0].sessions[0].assignment.runId = "run_replaced_at_execution"; },
  });
  const approval = sandbox.service();
  const focus = await approval.inspect(sandbox.request("final_fence").id);
  assert.equal((await approval.decide(decision(focus))).state, "invalidated");
  assert.deepEqual(sandbox.calls, []);
});

test("competing operator decisions across SQLite connections claim one execution", async (t) => {
  const { service, request, calls, open } = fixture(t);
  const first = service();
  const second = service(open());
  const attention = await first.inspect(request("competing").id);
  const outcomes = await Promise.allSettled([
    first.decide(decision(attention)), second.decide(decision(attention)),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.find(({ status }) => status === "rejected").reason.code, "already_decided");
  assert.deepEqual(calls, [{ method: "stop", reference: assignment }]);
});

test("an explicit native refusal settles approval and releases the automated fence", async (t) => {
  const { service, request, open } = fixture(t, {
    stop() { throw new HermesRuntimeError("native_refused", "The exact run refused stop."); },
  });
  const approval = service();
  const attention = await approval.inspect(request("native_refused").id);
  assert.equal((await approval.decide(decision(attention))).state, "invalidated");
  assert.equal(open().sessionControl(session.id), undefined);
});

test("independent operator processes share the same durable decision claim", async (t) => {
  const { database, directory, grants, request, service, time } = fixture(t);
  const attention = await service().inspect(request("processes").id);
  const calls = join(directory, "native-calls");
  const program = `
    import { appendFileSync } from "node:fs";
    import { ApprovalService } from "@praxis/approvals";
    import { OperationalStore } from "@praxis/state";
    const [database, grants, input, now, calls] = process.argv.slice(1);
    const store = new OperationalStore(database);
    const service = new ApprovalService({
      store,
      loadGrants: async () => JSON.parse(grants),
      now: () => Number(now),
      runtime: {
        async stopAssignment(reference, authorize) {
          await authorize();
          appendFileSync(calls, reference.runId + "\\n");
          return {
            schemaVersion: 1, taskId: reference.taskId, sessionId: reference.sessionId, status: "stopping",
            output: { availability: "unavailable", reason: "Fixture run is stopping" },
          };
        },
      },
    });
    try {
      process.stdout.write((await service.decide(JSON.parse(input))).state);
    } catch (error) {
      if (error.code !== "already_decided") throw error;
      process.stdout.write(error.code);
    } finally {
      store.close();
    }
  `;
  const args = [
    "--input-type=module", "--eval", program, database, JSON.stringify(grants),
    JSON.stringify(decision(attention)), String(time.now), calls,
  ];
  const outcomes = await Promise.all([
    execute(process.execPath, args, { timeout: 15_000 }),
    execute(process.execPath, args, { timeout: 15_000 }),
  ]);
  assert.deepEqual(outcomes.map(({ stdout }) => stdout).sort(), ["already_decided", "resolved"]);
  assert.equal(readFileSync(calls, "utf8"), `${assignment.runId}\n`);
});

test("a claimed or uncertain execution is never reissued after a service restart", async (t) => {
  let entered;
  let finish;
  const stopping = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((_, reject) => { finish = reject; });
  const { service, request, calls, open } = fixture(t, { stop: () => { entered(); return pending; } });
  const before = service();
  const attention = await before.inspect(request("uncertain").id);
  const original = before.decide(decision(attention));
  await stopping;
  const restarted = service(open());
  assert.equal((await restarted.list())[0].state, "uncertain");
  await assert.rejects(restarted.decide(decision(attention)), { code: "already_decided" });
  finish(new Error("The fixture connection was lost before acknowledging stop"));
  assert.equal((await original).state, "uncertain");
  assert.equal((await service(open()).list())[0].state, "uncertain");
  assert.equal(open().sessionControl(session.id).mode, "automated_write");
  assert.equal(calls.length, 1);
});

test("routine inspection resolves within scope and unsupported or foreign requests cannot execute", async (t) => {
  const { service, request, calls } = fixture(t);
  const approval = service();
  const eligible = request("routine", "session.inspect");
  const restricted = request("routine_pass_stop");
  await approval.advanceRoutine();
  const items = new Map((await approval.list()).map((item) => [item.requestId, item]));
  const routine = items.get(eligible.id);
  assert.equal(routine.state, "resolved");
  assert.equal(routine.native.status, "running");
  assert.equal(items.get(restricted.id).state, "processing");
  assert.equal((await approval.inspect(request("unknown", "task.archive").id)).state, "refused");
  assert.equal((await approval.inspect(request("foreign", "session.stop", { kind: "session", id: "session_foreign" }).id)).state, "refused");
  assert.deepEqual(calls, [{ method: "inspect", reference: assignment }]);
});
