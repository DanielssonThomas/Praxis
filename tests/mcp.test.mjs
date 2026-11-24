import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eventSchema } from "@praxis/contracts";
import { createPraxisMcpServer } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";

const task = { schemaVersion: 1, id: "task_1", title: "Check local work" };
const session = { schemaVersion: 1, id: "session_1", taskId: task.id };
const otherTask = { schemaVersion: 1, id: "task_2", title: "Outside the granted task" };
const otherSession = { schemaVersion: 1, id: "session_2", taskId: otherTask.id };
const assignment = { schemaVersion: 1, taskId: task.id, sessionId: session.id, runId: "run_fixture1" };
const workerToken = "fixture-worker-token-that-is-long-enough";
const observerToken = "fixture-observer-token-that-is-long-enough";
const occurredAt = "2026-07-28T10:30:00Z";
const digest = (token) => createHash("sha256").update(token).digest("hex");

async function fixture(t, runtime) {
  const directory = await mkdtemp(join(tmpdir(), "praxis-mcp-"));
  const database = join(directory, "state.sqlite");
  const store = new OperationalStore(database);
  for (const record of [task, otherTask]) store.recordTask(record);
  for (const record of [session, otherSession]) store.recordSession(record);
  const grants = [
    {
      principalId: "principal_worker",
      tokenDigest: digest(workerToken),
      taskIds: [task.id],
      sessions: [{ sessionId: session.id, canReport: true, assignment }],
      actionKinds: ["session.stop"],
    },
    {
      principalId: "principal_observer",
      tokenDigest: digest(observerToken),
      taskIds: [task.id],
      sessions: [{ sessionId: session.id, canReport: false }],
      actionKinds: [],
    },
  ];
  const server = createPraxisMcpServer({ store, grants, runtime });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    store,
    grants,
    database,
    url,
    async connect(token = workerToken) {
      const client = new Client({ name: "praxis-protocol-fixture", version: "1.0" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      return client;
    },
  };
}

function report(overrides = {}) {
  return {
    submissionId: "event_fixture1",
    sessionId: session.id,
    phase: "progress",
    occurredAt,
    message: "Durable worker result",
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    submissionId: "event_fixture2",
    occurredAt,
    kind: "session.stop",
    target: { kind: "session", id: session.id },
    ...overrides,
  };
}

const call = (client, name, args) => client.callTool({ name, arguments: args });

test("authenticated MCP clients inspect canonical task and worker records, including native availability", async (t) => {
  const runtimeSnapshot = {
    schemaVersion: 1,
    taskId: task.id,
    sessionId: session.id,
    status: "running",
    output: { availability: "unavailable", reason: "no native output yet" },
  };
  let projected = runtimeSnapshot;
  const { connect } = await fixture(t, { inspectAssignment: async (actual) => {
    assert.deepEqual(actual, assignment);
    return projected;
  } });
  const client = await connect();
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(({ name }) => name), ["inspect_task", "inspect_worker", "report_worker", "request_action"]);
  assert.deepEqual((await call(client, "inspect_task", { taskId: task.id })).structuredContent.task, task);
  const worker = (await call(client, "inspect_worker", { sessionId: session.id })).structuredContent;
  assert.deepEqual(worker.session, session);
  assert.deepEqual(worker.runtime, { availability: "available", snapshot: runtimeSnapshot });
  projected = { ...runtimeSnapshot, sessionId: otherSession.id };
  const mismatch = await call(client, "inspect_worker", { sessionId: session.id });
  assert.equal(mismatch.isError, true);
  assert.equal(mismatch.structuredContent.code, "forbidden");

  const observer = await connect(observerToken);
  const observed = (await call(observer, "inspect_worker", { sessionId: session.id })).structuredContent;
  assert.equal(observed.runtime.availability, "unavailable");
  assert.match(observed.runtime.reason, /assignment/i);
});

test("reports and scoped requests are durable, actor-bound, and replay once", async (t) => {
  const { connect, database, store } = await fixture(t);
  const client = await connect();
  for (const phase of ["progress", "result", "blocked"]) {
    const input = report({ phase, submissionId: `event_${phase}` });
    const stored = (await call(client, "report_worker", input)).structuredContent;
    assert.equal(stored.write, "inserted");
    assert.equal(stored.event.kind, `worker.${phase}`);
    assert.deepEqual(stored.event.details, { type: "worker_report", actorId: "principal_worker", message: input.message });
    assert.deepEqual(eventSchema.parse(stored.event), stored.event);
    const retried = (await call(client, "report_worker", input)).structuredContent;
    assert.equal(retried.write, "duplicate");
    assert.equal(retried.event.id, stored.event.id);
  }
  assert.equal(store.eventsFor(session.id).length, 3);
  const conflicting = await call(client, "report_worker", report({ submissionId: "event_progress", message: "Conflicting" }));
  assert.equal(conflicting.isError, true);

  const submitted = (await call(client, "request_action", request())).structuredContent;
  assert.equal(submitted.status, "pending");
  assert.equal(submitted.event.kind, "action.requested");
  assert.deepEqual(submitted.event.details.action.target, { kind: "session", id: session.id });
  assert.equal(submitted.event.details.actorId, "principal_worker");
  assert.equal((await call(client, "request_action", request())).structuredContent.write, "duplicate");

  const reopened = new OperationalStore(database);
  try {
    assert.equal(reopened.eventsFor(session.id).length, 4);
    assert.deepEqual(reopened.getEvent(submitted.event.id), submitted.event);
  } finally {
    reopened.close();
  }
});

test("missing auth, cross-scope writes and invalid input fail without storing records", async (t) => {
  const { connect, store, url } = await fixture(t);
  const unauthenticated = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_worker", arguments: report() } }),
  });
  assert.equal(unauthenticated.status, 401);
  const wrongToken = await fetch(url, {
    headers: { Authorization: "Bearer fixture-unknown-token-that-is-long-enough" },
  });
  assert.equal(wrongToken.status, 401);

  const client = await connect();
  assert.equal((await call(client, "inspect_task", { taskId: otherTask.id })).isError, true);
  assert.equal((await call(client, "inspect_worker", { sessionId: otherSession.id })).isError, true);
  assert.equal((await call(client, "report_worker", report({ sessionId: otherSession.id }))).isError, true);
  assert.equal((await call(client, "report_worker", report({ message: "x".repeat(8193) }))).isError, true);
  assert.equal((await call(client, "report_worker", report({ actorId: "principal_imposter" }))).isError, true);
  assert.equal((await call(client, "request_action", request({ kind: "task.archive" }))).isError, true);
  assert.equal((await call(client, "request_action", request({ target: { kind: "session", id: otherSession.id } }))).isError, true);
  assert.equal((await call(client, "request_action", request({ approved: true }))).isError, true);

  const observer = await connect(observerToken);
  assert.equal((await call(observer, "report_worker", report())).isError, true);
  assert.equal((await call(observer, "request_action", request())).isError, true);
  assert.deepEqual(store.eventsFor(session.id), []);
  assert.deepEqual(store.eventsFor(otherSession.id), []);
});
