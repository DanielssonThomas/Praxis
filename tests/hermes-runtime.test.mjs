import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const prefix = options.profile ? `/p/${options.profile}` : "";
  const admissions = new Map();
  const receipts = new Map();
  let sessionId;
  let status = options.status ?? "running";
  const server = createServer(async (request, response) => {
    const routePrefix = options.defaultAlias && request.url.startsWith("/p/default/") ? "/p/default" : prefix;
    const path = request.url.startsWith(routePrefix + "/") ? request.url.slice(routePrefix.length) : undefined;
    const transcriptId = /^\/api\/sessions\/([^/]+)\/messages\?/.exec(path ?? "")?.[1];
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: request.url, method: request.method, headers: request.headers, body });

    const send = (code, value) => response.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (request.headers.authorization !== `Bearer ${key}`) {
      send(401, { message: "missing or incorrect fixture key" });
    } else if (options.redirect && path === "/v1/capabilities") {
      response.writeHead(307, { Location: "/unexpected" }).end();
    } else if (path === "/v1/capabilities") {
      send(200, {
        platform: "hermes-agent",
        auth: { type: "bearer", required: true },
        features: { run_submission: true, run_status: true, run_stop: true, ...options.features },
      });
    } else if (options.turns && path === "/v1/runs" && request.method === "POST") {
      const identity = request.headers["idempotency-key"];
      const admitted = admissions.get(identity);
      if (admitted && JSON.stringify(admitted.body) !== JSON.stringify(body)) {
        send(409, { error: { code: "idempotency_key_conflict" } });
      } else if (admitted) {
        send(202, { run_id: admitted.runId });
      } else {
        const id = `run_fixture_turn_${admissions.size}`;
        admissions.set(identity, { body, runId: id });
        receipts.set(id, {
          run_id: id, session_id: body.session_id, status: options.status ?? "completed", output: body.input,
        });
        send(202, { run_id: id });
      }
    } else if (options.turns && request.method === "GET" && path?.startsWith("/v1/runs/") && receipts.has(path.slice("/v1/runs/".length))) {
      send(200, receipts.get(path.slice("/v1/runs/".length)));
    } else if (path === "/v1/runs" && request.method === "POST") {
      sessionId = body.session_id;
      send(202, { run_id: runId, status: "started" });
    } else if (path === `/v1/runs/${runId}` && request.method === "GET") {
      send(200, { run_id: runId, session_id: options.foreignSession ?? sessionId, status, output: options.output });
    } else if (path === `/v1/runs/${runId}/stop` && request.method === "POST") {
      status = "cancelled";
      send(200, { status: "stopping" });
    } else if (options.features?.run_events_sse && path === `/v1/runs/${runId}/events`) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const data = JSON.stringify({ seq: 1, event: "message.delta", run_id: runId, delta: "profile output" });
      response.end(`id: 1\ndata: ${data}\n\n`);
    } else if (options.features?.run_steer && path === `/v1/runs/${runId}/steer` && request.method === "POST") {
      send(200, { run_id: runId, accepted: true });
    } else if (options.transcript && transcriptId !== undefined && (transcriptId === sessionId
      || [...receipts.values()].some((receipt) => receipt.session_id === transcriptId))) {
      const query = new URL(path, "http://127.0.0.1").searchParams;
      const limit = Number(query.get("limit"));
      const offset = Number(query.get("offset") ?? "0");
      const data = options.transcript(limit, offset);
      send(200, { session_id: transcriptId, data, pagination: { limit, offset, order: "latest", returned: data.length } });
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
  return { calls, origin, adapter: new HermesRuntime({ origin: origin + prefix + (options.suffix ?? ""), apiKey: key }) };
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

test("guidance reconciliation can reach past the newest page but holds on a changing page boundary", async (t) => {
  const text = "Check the fixture";
  const receipt = {
    id: 23, role: "user", display_kind: "steer",
    content: `[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]\n${text}\n[/OUT-OF-BAND USER MESSAGE]`,
  };
  const rows = Array.from({ length: 150 }, (_, index) => index === 22
    ? receipt : { id: index + 1, role: "assistant", content: "Fixture output" });
  let changed = false;
  const { adapter } = await fixture(t, { transcript: (limit, offset) => {
    const end = rows.length - offset + (changed && offset > 0 ? 1 : 0);
    return rows.slice(Math.max(0, end - limit), end);
  } });
  const assignment = await adapter.createAssignment(session, text);
  const digest = createHash("sha256").update(text).digest("hex");
  assert.equal(await adapter.reconcileGuidance(assignment, 8, digest), "delivered");
  assert.equal(await adapter.reconcileGuidance(assignment, 23, digest), undefined);
  changed = true;
  await assert.rejects(adapter.reconcileGuidance(assignment, 8, digest), {
    code: "unavailable", message: /transcript changed/,
  });
});

test("the named base URL prefixes Runs, streaming, control and transcript requests", async (t) => {
  const profile = "praxis-manager";
  const prefix = `/p/${profile}`;
  const { adapter, calls } = await fixture(t, {
    profile, suffix: "/",
    features: { run_events_sse: true, run_steer: true, session_resources: true },
    transcript: () => [{ id: 9, role: "user", content: "Fixture input" }],
  });
  const assignment = await adapter.createAssignment(session, "Fixture");
  assert.equal((await adapter.inspectAssignment(assignment)).status, "running");
  const live = await adapter.inspectLiveAssignment(assignment);
  assert.equal(live.snapshot.output.text, "profile output");
  await adapter.inspectLiveAssignment(assignment, live.cursor);
  assert.equal(await adapter.guidanceBaseline(assignment), 9);
  let authorized = false;
  await adapter.steerAssignment(assignment, "Native guidance", async () => { authorized = true; });
  assert.equal(authorized, true);
  assert.equal((await adapter.stopAssignment(assignment)).status, "stopping");

  assert.ok(calls.every(({ path, headers }) => path.startsWith(prefix + "/") && headers.authorization === `Bearer ${key}`));
  const nativeSession = calls.find(({ path }) => path === `${prefix}/v1/runs`).body.session_id;
  assert.deepEqual(new Set(calls.map(({ path }) => path.slice(prefix.length))), new Set([
    "/v1/capabilities",
    "/v1/runs",
    `/v1/runs/${runId}`,
    `/v1/runs/${runId}/events`,
    `/api/sessions/${nativeSession}/messages?limit=1&offset=0&order=latest&include_compacted=true`,
    `/v1/runs/${runId}/steer`,
    `/v1/runs/${runId}/stop`,
  ]));
  const eventCalls = calls.filter(({ path }) => path.endsWith("/events"));
  assert.deepEqual(eventCalls.map(({ headers }) => headers["last-event-id"]), [undefined, "1"]);
  assert.deepEqual(calls.find(({ path }) => path.endsWith("/steer")).body, { input: "Native guidance" });
});

test("Hermes endpoint validation rejects raw paths and delimiters that URL normalization can hide", () => {
  const origin = "http://127.0.0.1:3212";
  const invalid = [
    "/v1/runs", "/p/", "/p/Praxis", "/p/-manager", "/p/a.b", `/p/${"a".repeat(65)}`,
    "/p/%70raxis", "/p/%61%2fb", "/p/manager%5cother", "/p/manager/extra", "/p/manager//",
    "/p/manager/..", "/p/manager/../../", "/p/./manager", "/p/%2e/manager", "/p/a/%2e%2e/manager",
    "/p/manager\\..", "/./", "/%2e/", "/p/manager?", "/p/manager#", "/?", "/#", "?", "#",
    "/p/prax\tis", "/p/manager\n", "/p/manager\r", "/p/manager\u0000", " ",
  ];
  for (const path of invalid) {
    assert.throws(() => new HermesRuntime({ origin: origin + path, apiKey: key }), { code: "invalid_input" }, JSON.stringify(path));
  }
  for (const endpoint of [
    "http:127.0.0.1:3212", "http:///127.0.0.1:3212", "http://%31%32%37.0.0.1",
    "http://127.0.0.1:", "http://127.0.0.1:99999", "http://@127.0.0.1",
    "http://user:pass@127.0.0.1", "ftp://127.0.0.1", "http://localhost", "http://192.0.2.1",
  ]) {
    assert.throws(() => new HermesRuntime({ origin: endpoint, apiKey: key }), { code: "invalid_input" }, endpoint);
  }
  for (const endpoint of [
    origin, origin + "/", origin + "/p/default", origin + "/p/a_0-9",
    "http://[0:0:0:0:0:0:0:1]:3212/", "http://127.1:3212", "http://0x7f000001",
    `https://[::1]:3212/p/${"a".repeat(64)}`,
  ]) {
    assert.doesNotThrow(() => new HermesRuntime({ origin: endpoint, apiKey: key }), endpoint);
  }
  assert.throws(() => new HermesRuntime({ origin, apiKey: "invalid\r\nAuthorization: other" }), { code: "invalid_input" });
});

test("the named profile bearer stays on the configured route when it returns a redirect", async (t) => {
  const { adapter, calls } = await fixture(t, { profile: "praxis-manager", redirect: true });
  await assert.rejects(adapter.capabilities(), { code: "unavailable" });
  assert.deepEqual(calls.map(({ path, headers }) => [path, headers.authorization]), [
    ["/p/praxis-manager/v1/capabilities", `Bearer ${key}`],
  ]);
});


test("named explicit turns share a scoped native session and keep legacy assignments compatible", async (t) => {
  const profile = "praxis-manager";
  const base = `/p/${profile}`;
  const guidance = "Scoped guidance.";
  const transcript = () => [{ id: 7, role: "user", content: guidance }];
  const { adapter, calls, origin } = await fixture(t, { profile, turns: true, transcript });
  const reconnected = new HermesRuntime({ origin: origin + base + "/", apiKey: key });
  const nativeSession = `praxis-${createHash("sha256").update(session.taskId).update("\0").update(session.id).digest("hex")}`;

  const legacy = await adapter.createAssignment(session, "Initial turn");
  assert.deepEqual(await reconnected.createAssignment(session, "Initial turn"), legacy);
  const legacyReference = JSON.parse(JSON.stringify(legacy));
  const turn = await adapter.submitTurn(session, "Follow-up", "turn_fixture_A");
  const retry = await reconnected.submitTurn(session, "Follow-up", "turn_fixture_A");
  assert.deepEqual(retry, turn);
  const next = await adapter.submitTurn(session, "Follow-up", "B".repeat(128));
  const otherSession = { ...session, id: "session_other" };
  const otherTask = { ...session, taskId: "task_other" };
  const differentSession = await adapter.submitTurn(otherSession, "Follow-up", "turn_fixture_A");
  const differentTask = await adapter.submitTurn(otherTask, "Follow-up", "turn_fixture_A");
  await assert.rejects(reconnected.submitTurn(session, "Changed input", "turn_fixture_A"), {
    code: "native_refused", message: /HTTP 409/,
  });

  assert.deepEqual(turn, { ...legacy, runId: turn.runId });
  assert.equal(new Set([legacy, turn, next, differentSession, differentTask].map(({ runId }) => runId)).size, 5);
  assert.equal((await reconnected.inspectAssignment(legacyReference)).output.text, "Initial turn");
  assert.equal((await reconnected.inspectAssignment(turn)).output.text, "Follow-up");
  await assert.rejects(reconnected.inspectAssignment({ ...turn, sessionId: otherSession.id }), { code: "assignment_mismatch" });
  await assert.rejects(reconnected.inspectAssignment({ ...turn, taskId: otherTask.taskId }), { code: "assignment_mismatch" });

  const submissions = calls.filter(({ method, path }) => method === "POST" && path === base + "/v1/runs");
  assert.equal(submissions.length, 8);
  const sessionIds = submissions.map(({ body }) => body.session_id);
  assert.ok(sessionIds.slice(0, 2).every((id) => id === nativeSession));
  const scopedSession = sessionIds[2];
  assert.ok([...sessionIds.slice(2, 5), sessionIds[7]].every((id) => id === scopedSession));
  assert.equal(new Set([nativeSession, scopedSession, sessionIds[5], sessionIds[6]]).size, 4);

  const digest = createHash("sha256").update(guidance).digest("hex");
  assert.equal(await adapter.reconcileGuidance(legacyReference, 0, digest), "recorded");
  assert.equal(await adapter.reconcileGuidance(turn, 0, digest), "recorded");
  const transcripts = calls.filter(({ path }) => path.startsWith(base + "/api/sessions/"));
  assert.deepEqual(transcripts.map(({ path }) => path.split("/")[5]), [nativeSession, scopedSession]);
  const keys = submissions.map(({ headers }) => headers["idempotency-key"]);
  assert.equal(keys[0], nativeSession);
  assert.equal(keys[1], nativeSession);
  assert.equal(keys[2], keys[3]);
  assert.equal(keys[2], keys[7]);
  assert.equal(new Set([keys[0], keys[2], keys[4], keys[5], keys[6]]).size, 5);
  assert.ok(keys.every((value) => /^[!-~]{1,255}$/.test(value)));
  assert.ok(calls.every(({ path, headers }) => path.startsWith(base + "/") && headers.authorization === `Bearer ${key}`));

  const wrongProfile = await fixture(t, { profile: "other-profile", foreignSession: scopedSession });
  const wrongAssignment = await wrongProfile.adapter.createAssignment(session, "Fixture");
  await assert.rejects(wrongProfile.adapter.inspectAssignment(wrongAssignment), { code: "assignment_mismatch" });
});

test("submitTurn rejects invalid caller identities before calling the gateway", async (t) => {
  const { adapter, calls } = await fixture(t, { turns: true });
  for (const identity of [undefined, null, 1, "", " turn", "a b", "_turn", "turn/other", "turn\n", "turn\u0000", "x".repeat(129)]) {
    await assert.rejects(adapter.submitTurn(session, "Fixture", identity), { code: "invalid_input" });
  }
  assert.deepEqual(calls, []);
});


test("default aliases share an idempotency namespace and the exact native guidance transcript", async (t) => {
  const { adapter, calls, origin } = await fixture(t, {
    turns: true, defaultAlias: true, status: "running",
    features: { run_steer: true, session_resources: true },
    transcript: () => [{ id: 9, role: "user", content: "Fixture guidance" }],
  });
  const explicitDefault = new HermesRuntime({ origin: origin + "/p/default", apiKey: key });
  const bare = await adapter.submitTurn(session, "Fixture", "stable-turn");
  assert.deepEqual(await explicitDefault.submitTurn(session, "Fixture", "stable-turn"), bare);
  const submissions = calls.filter(({ method }) => method === "POST");
  assert.deepEqual(submissions[0].body, submissions[1].body);
  assert.equal(submissions[0].headers["idempotency-key"], submissions[1].headers["idempotency-key"]);
  assert.equal(await explicitDefault.guidanceBaseline(bare), 9);
  assert.equal(calls.at(-1).path,
    `/p/default/api/sessions/${submissions[0].body.session_id}/messages?limit=1&offset=0&order=latest&include_compacted=true`);
});
