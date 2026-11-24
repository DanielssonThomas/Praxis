import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { runtimeOutputLimit, runtimeSessionSnapshotSchema } from "@praxis/contracts";
import { HermesRuntime } from "@praxis/hermes-runtime";

const session = { schemaVersion: 1, id: "session_31", taskId: "task_19" };
const key = "fixture-token";
const runId = "run_fixture123";

async function fixture(t, options = {}) {
  const calls = [];
  let sessionId;
  let status = options.status ?? "running";
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: request.url, method: request.method, headers: request.headers, body });

    const send = (code, value) => response.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (request.headers.authorization !== `Bearer ${key}`) {
      send(401, { message: "missing or incorrect fixture key" });
    } else if (request.url === "/v1/capabilities") {
      send(200, {
        platform: "hermes-agent",
        auth: { type: "bearer", required: true },
        features: { run_submission: true, run_status: true, run_stop: true, ...options.features },
      });
    } else if (request.url === "/v1/runs" && request.method === "POST") {
      sessionId = body.session_id;
      send(202, { run_id: runId, status: "started" });
    } else if (request.url === `/v1/runs/${runId}` && request.method === "GET") {
      send(200, { run_id: runId, session_id: options.foreignSession ?? sessionId, status, output: options.output });
    } else if (request.url === `/v1/runs/${runId}/stop` && request.method === "POST") {
      status = "cancelled";
      send(200, { status: "stopping" });
    } else {
      send(404, { message: "unknown fixture route" });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { calls, origin, adapter: new HermesRuntime({ origin, apiKey: key }) };
}

test("the adapter submits an authorized native run in a stable API session and normalizes inspection", async (t) => {
  const { adapter, calls } = await fixture(t);
  const assignment = await adapter.createAssignment(session, "Check the fixture");
  assert.equal(assignment.runId, runId);
  assert.equal(assignment.sessionId, session.id);
  assert.equal(assignment.taskId, session.taskId);
  assert.deepEqual(await adapter.createAssignment(session, "Check the fixture"), assignment);
  const submissions = calls.filter(({ path }) => path === "/v1/runs");
  assert.equal(submissions.length, 2);
  assert.match(submissions[0].body.session_id, /^praxis-[a-f0-9]{64}$/);
  assert.equal(submissions[0].body.input, "Check the fixture");
  assert.equal(submissions[0].headers["idempotency-key"], submissions[1].headers["idempotency-key"]);
  assert.equal(submissions[0].body.session_id, submissions[1].body.session_id);
  assert.ok(calls.every(({ headers }) => headers.authorization === `Bearer ${key}`));

  const active = await adapter.inspectAssignment(assignment);
  assert.deepEqual(runtimeSessionSnapshotSchema.parse(active), active);
  assert.equal(active.status, "running");
  assert.equal(active.output.availability, "unavailable");
  const stopped = await adapter.stopAssignment(assignment);
  assert.equal(stopped.status, "stopping");
  assert.equal((await adapter.inspectAssignment(assignment)).status, "stopped");
});

test("completed and unknown native states expose bounded output and unknown status", async (t) => {
  const receipt = "x".repeat(runtimeOutputLimit) + "last";
  const { adapter } = await fixture(t, { status: "completed", output: receipt });
  const complete = await adapter.inspectAssignment(await adapter.createAssignment(session, "Fixture"));
  assert.equal(complete.status, "completed");
  assert.equal(complete.output.text, receipt.slice(-runtimeOutputLimit));
  assert.equal(complete.output.truncated, true);
  assert.equal(runtimeSessionSnapshotSchema.safeParse({ ...complete, sessionId: session.taskId }).success, false);

  const later = await fixture(t, { status: "unexpected-new-state" });
  const future = await later.adapter.inspectAssignment(await later.adapter.createAssignment(session, "Fixture"));
  assert.equal(future.status, "unknown");
  assert.equal(future.output.availability, "unavailable");

  const failedRuntime = await fixture(t, { status: "failed", output: null });
  const failed = await failedRuntime.adapter.inspectAssignment(
    await failedRuntime.adapter.createAssignment(session, "Fixture"),
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.output.availability, "unavailable");
});

test("the adapter reports capability gaps and refuses unsupported controls", async (t) => {
  const { adapter, calls } = await fixture(t, { features: { run_stop: false } });
  const capabilities = await adapter.capabilities();
  assert.equal(capabilities.submission.available, true);
  assert.equal(capabilities.stop.available, false);
  assert.match(capabilities.stop.reason, /run_stop/);
  assert.equal(capabilities.kanban.available, false);
  assert.equal(capabilities.liveOutput.available, false);

  const assignment = await adapter.createAssignment(session, "Fixture");
  await assert.rejects(adapter.stopAssignment(assignment), { code: "unsupported" });
  assert.equal(calls.some(({ path }) => path.endsWith("/stop")), false);
});

test("bearer refusal, malformed handles and a foreign native session cannot issue a stop", async (t) => {
  const { adapter, origin, calls } = await fixture(t, { foreignSession: "different-session" });
  await assert.rejects(new HermesRuntime({ origin, apiKey: "incorrect" }).capabilities(), { code: "unauthorized" });
  assert.throws(() => new HermesRuntime({ origin: "https://example.test", apiKey: key }), { code: "invalid_input" });

  const assignment = await adapter.createAssignment(session, "Fixture");
  await assert.rejects(adapter.stopAssignment({ ...assignment, runId: "../unexpected" }), { code: "invalid_input" });
  await assert.rejects(adapter.stopAssignment(assignment), { code: "assignment_mismatch" });
  assert.equal(calls.some(({ path }) => path.endsWith("/stop")), false);
});
