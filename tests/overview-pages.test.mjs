import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationalStore } from "@praxis/state";
import { OverviewService } from "../packages/shell/dist/overview-server.js";
import { startShell, stopProcess } from "./runtime/hermes-fixture.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function grant(assignments = []) {
  return {
    principalId: "principal_paging_fixture",
    tokenDigest: digest("paging-fixture-principal"),
    taskIds: assignments.map(({ taskId }) => taskId),
    sessions: assignments.map((assignment) => ({ sessionId: assignment.sessionId, assignment, canReport: false })),
    actionKinds: [],
  };
}

function prepare(t, beforeInspect) {
  const store = new OperationalStore(":memory:");
  t.after(() => store.close());
  const assignments = Array.from({ length: 11 }, (_, index) => {
    const id = String(index + 1);
    const task = { schemaVersion: 1, id: "task_page_" + id, title: "Paging fixture " + id };
    const session = { schemaVersion: 1, id: "session_page_" + id, taskId: task.id };
    store.recordTask(task);
    store.recordSession(session);
    return { schemaVersion: 1, sessionId: session.id, taskId: task.id, runId: "run_page_" + id };
  });
  let registered = assignments;
  const calls = [];
  const overview = new OverviewService({
    store,
    loadGrants: async () => [grant(registered)],
    controls: { view: () => ({ mode: "read_only" }) },
    runtime: {
      async inspectLiveAssignment(assignment, previous) {
        const { taskId, sessionId, runId } = assignment;
        calls.push({ runId, previous });
        await beforeInspect?.(runId);
        const seq = (previous?.seq ?? -1) + 1;
        const output = { availability: "available", text: runId + ":" + seq, truncated: false };
        return {
          snapshot: { taskId, sessionId, status: "running", output },
          usage: { sessionId, metering: "unknown", reason: "Fixture usage unavailable." },
          cursor: { runId, seq, output, truncated: false },
        };
      },
    },
  });
  return { overview, assignments, calls, register: (next) => { registered = next; } };
}

const sessionIds = (projection) => projection.panes.map(({ session }) => session.id);

test("Overview serves the next ten-bounded page and clamps empty or shrinking registrations", async (t) => {
  const { overview, assignments, calls, register } = prepare(t);
  const first = await overview.list();
  assert.deepEqual(sessionIds(first), assignments.slice(0, 10).map(({ sessionId }) => sessionId));
  assert.deepEqual(calls.splice(0).map(({ runId }) => runId), assignments.slice(0, 10).map(({ runId }) => runId));
  const second = await overview.list(2);
  assert.deepEqual(sessionIds(second), ["session_page_11"], "an explicit page reaches the eleventh eligible worker");
  assert.deepEqual(first.page, { number: 1, count: 2 });
  assert.deepEqual(second.page, { number: 2, count: 2 });
  assert.deepEqual(calls.splice(0), [{ runId: "run_page_11", previous: undefined }]);

  await overview.list(1);
  assert.equal(calls[0].previous.seq, 0, "returning to a page resumes its own replay cursor");
  assert.equal(calls[0].previous.runId, "run_page_1");
  calls.length = 0;
  register(assignments.slice(0, 3));
  const shrunk = await overview.list(2);
  assert.deepEqual(shrunk.page, { number: 1, count: 1 });
  assert.deepEqual(sessionIds(shrunk), assignments.slice(0, 3).map(({ sessionId }) => sessionId));
  register([]);
  const empty = await overview.list(4);
  assert.deepEqual(empty.page, { number: 1, count: 1 });
  assert.deepEqual(sessionIds(empty), []);
  register(assignments.slice(10));
  calls.length = 0;
  await overview.list(1);
  assert.deepEqual(calls, [{ runId: "run_page_11", previous: undefined }], "a revoked assignment loses its cursor");
});

test("overlapping Overview reads keep different pages and coalesce a clamped alias", { timeout: 3_000 }, async (t) => {
  const firstStarted = Promise.withResolvers();
  const firstHold = Promise.withResolvers();
  const lastHold = Promise.withResolvers();
  t.after(firstHold.resolve);
  t.after(lastHold.resolve);
  const { overview, calls } = prepare(t, (runId) => {
    if (runId === "run_page_1") {
      firstStarted.resolve();
      return firstHold.promise;
    }
    if (runId === "run_page_11") return lastHold.promise;
  });

  const first = overview.list(1);
  await firstStarted.promise;
  const second = overview.list(2);
  const clamped = overview.list(9);
  await new Promise((resolve) => setImmediate(resolve));
  lastHold.resolve();
  for (const result of await Promise.all([second, clamped])) {
    assert.deepEqual(sessionIds(result), ["session_page_11"]);
    assert.equal(result.panes[0].runtime.snapshot.output.text, "run_page_11:0");
  }
  assert.equal(calls.filter(({ runId }) => runId === "run_page_11").length, 1);
  firstHold.resolve();
  assert.equal((await first).panes.length, 10);
});

test("Overview paging authenticates before exposing page metadata or validation errors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-overview-pages-"));
  let shell;
  t.after(async () => {
    await stopProcess(shell?.processHandle);
    await rm(directory, { recursive: true, force: true });
  });
  const authority = join(directory, "authority.json");
  const operator = randomBytes(32).toString("base64url");
  await writeFile(authority, JSON.stringify({
    schemaVersion: 1,
    database: join(directory, "state.sqlite"),
    grants: [grant()],
  }), { mode: 0o600 });
  shell = await startShell(directory, {
    PRAXIS_MCP_CONFIG_FILE: authority,
    PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator),
    PRAXIS_HERMES_ORIGIN: "http://127.0.0.1:1",
    PRAXIS_HERMES_API_KEY: randomBytes(32).toString("base64url"),
  });
  const get = (suffix = "", credential = operator) => fetch(new URL("/api/overview" + suffix, shell.origin), {
    headers: { Authorization: "Bearer " + credential },
  });

  const locked = await get("?page=invalid", randomBytes(32).toString("base64url"));
  assert.equal(locked.status, 401);
  assert.equal((await locked.json()).page, undefined);

  const explicit = await get("?page=1");
  assert.equal(explicit.status, 200);
  assert.deepEqual((await explicit.json()).page, { number: 1, count: 1 });
  assert.deepEqual((await (await get()).json()).page, { number: 1, count: 1 });

  for (const suffix of ["?page=", "?page=0", "?page=-1", "?page=1.5", "?page=1e1", "?page=4294967296", "?page=1&page=2"]) {
    const invalid = await get(suffix);
    assert.equal(invalid.status, 400, suffix);
    const error = await invalid.json();
    assert.equal(error.code, "invalid_input");
    assert.equal(error.page, undefined);
  }
});
