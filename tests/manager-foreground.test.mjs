import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationalStore } from "@praxis/state";
import { startShell, stopProcess } from "./runtime/hermes-fixture.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("the local manager route authenticates the operator and only submits the fixed foreground session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-foreground-route-"));
  let shell;
  let submissions = 0;
  let sessionId;
  const calls = [];
  const task = { schemaVersion: 1, id: "task_card", title: "Authoritative local task" };
  const foreign = { schemaVersion: 1, id: "task_foreign", title: "Foreign local task" };
  const worker = { schemaVersion: 1, id: "session_card", taskId: task.id };
  const output = ["Fixture task inspected.", "", `[[praxis:task:${task.id}]]`, `[[praxis:session:${worker.id}]]`,
    "[[praxis:task:task_missing]]", `[[praxis:task:${foreign.id}]]`, "[[praxis:task:session_invalid]]"].join("\n");
  const server = createServer(async (request, response) => {
    calls.push(request.url);
    const json = (status, value) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    const route = request.url.replace("/p/praxis-manager", "");
    if (request.headers.authorization !== "Bearer fake-local-hermes") return json(401, {});
    if (route === "/v1/capabilities") return json(200, {
      platform: "hermes-agent",
      auth: { type: "bearer", required: true },
      features: { run_submission: true, run_status: true },
    });
    if (route === "/v1/runs" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.input, "Read the current task.");
      sessionId = body.session_id;
      submissions += 1;
      return json(202, { run_id: "run_manager_fixture" });
    }
    if (route === "/v1/runs/run_manager_fixture") return json(200, {
      run_id: "run_manager_fixture", session_id: sessionId, status: "completed",
      output, usage: { input_tokens: 8, output_tokens: 2 },
    });
    return json(404, {});
  });
  t.after(async () => {
    await stopProcess(shell?.processHandle);
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const operator = randomBytes(32).toString("base64url");
  const authority = join(directory, "authority.json");
  const database = join(directory, "local.sqlite");
  const store = new OperationalStore(database);
  try {
    store.recordTask(task);
    store.recordTask(foreign);
    store.recordSession(worker);
  } finally {
    store.close();
  }
  await writeFile(authority, JSON.stringify({
    schemaVersion: 1, database, grants: [{
      principalId: "principal_manager_fixture", tokenDigest: digest("fixture-mcp-only"),
      taskIds: [task.id, "task_missing"], sessions: [{ sessionId: worker.id, canReport: false }], actionKinds: [],
    }, {
      principalId: "principal_foreign_fixture", tokenDigest: digest("fixture-foreign"),
      taskIds: [foreign.id], sessions: [], actionKinds: [],
    }],
  }));
  shell = await startShell(directory, {
    PRAXIS_MCP_CONFIG_FILE: authority,
    PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator),
    PRAXIS_HERMES_ORIGIN: `http://127.0.0.1:${server.address().port}/p/praxis-manager`,
    PRAXIS_HERMES_API_KEY: "fake-local-hermes",
    PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID: "principal_manager_fixture",
  });
  const submit = (body, token = operator, origin = new URL(shell.origin).origin) => fetch(
    new URL("/api/manager/turn", shell.origin), {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const auth = (token) => fetch(new URL("/api/manager/turn", shell.origin), {
    method: "HEAD", headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal((await auth("fixture-mcp-only")).status, 401);
  assert.equal((await auth(operator)).status, 204);
  const turn = { turnId: "first-message", prompt: "Read the current task." };
  assert.equal((await submit(turn, "fixture-mcp-only")).status, 401);
  assert.equal((await submit(turn, operator, "http://example.invalid")).status, 403);
  assert.equal((await submit({ ...turn, sessionId: "session_spoofed" })).status, 400);
  assert.equal((await submit({ ...turn, turnId: "bad/id" })).status, 400);
  assert.deepEqual(calls, []);

  const response = await submit(turn);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/x-ndjson\b/);
  const records = (await response.text()).trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "snapshot");
  assert.equal(records[0].runId, "run_manager_fixture");
  assert.equal(records[0].snapshot.sessionId, "session_foreground_manager");
  assert.equal(records[0].snapshot.status, "completed");
  assert.equal(records[0].snapshot.output.text, "Fixture task inspected.");
  assert.deepEqual(records[0].resources, [
    { kind: "task", task }, { kind: "session", session: worker },
    { kind: "unavailable", resource: "task" }, { kind: "unavailable", resource: "task" },
  ]);
  assert.equal(records[0].usage.inputTokens, 8);
  assert.equal(submissions, 1);
  assert.ok(calls.every((path) => path.startsWith("/p/praxis-manager/")));
});
