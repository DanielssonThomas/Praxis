import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { runtimeOutputLimit, usageSchema } from "@praxis/contracts";
import { HermesRuntime } from "@praxis/hermes-runtime";

const session = { schemaVersion: 1, id: "session_overview", taskId: "task_overview" };
const runId = "run_overview_fixture";

async function fixture(t, options = {}) {
  let sessionId;
  const streams = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const send = (code, body) => response.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (request.url === "/v1/capabilities") {
      send(200, {
        platform: "hermes-agent", auth: { type: "bearer", required: true },
        features: { run_submission: true, run_status: true, run_events_sse: !options.noStream },
      });
    } else if (request.url === "/v1/runs") {
      sessionId = JSON.parse(Buffer.concat(chunks).toString()).session_id;
      send(202, { run_id: runId });
    } else if (request.url === `/v1/runs/${runId}`) {
      send(200, { run_id: runId, session_id: sessionId, status: "running", output: "", usage: options.usage });
    } else if (request.url === `/v1/runs/${runId}/events`) {
      const after = request.headers["last-event-id"];
      streams.push(after);
      if (options.expired) {
        send(404, {});
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (seq, name, data = {}) => `id: ${seq}\ndata: ${JSON.stringify({
        seq, event: name, run_id: options.foreign ? "run_foreign" : runId, ...data,
      })}\n\n`;
      if (options.replayGap) {
        if (after === undefined) {
          response.write(`data: ${JSON.stringify({ event: "replay.truncated", run_id: runId })}\n\n`);
          response.end(frame(3, "tool.started"));
        } else {
          response.end(frame(4, "message.delta", { delta: "retained output" }));
        }
        return;
      }
      response.write(frame(0, "message.delta", { delta: "first" }));
      if (after === undefined) response.end(frame(1, "tool.started"));
      else response.end(frame(2, "message.delta", { delta: "x".repeat(runtimeOutputLimit) + "tail" }));
    } else {
      send(404, {});
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const runtime = new HermesRuntime({ origin: `http://127.0.0.1:${server.address().port}`, apiKey: "fixture" });
  const assignment = await runtime.createAssignment(session, "Native overview fixture");
  return { runtime, assignment, streams };
}

test("overview reads live native deltas, advances across non-output events and resumes bounded", async (t) => {
  const { runtime, assignment, streams } = await fixture(t, { usage: { input_tokens: 0, output_tokens: 2 } });
  const active = await runtime.inspectLiveAssignment(assignment);
  assert.equal(active.snapshot.status, "running");
  assert.deepEqual(active.snapshot.output, { availability: "available", text: "first", truncated: false });
  assert.deepEqual(usageSchema.parse(active.usage), active.usage);
  assert.equal(active.usage.inputTokens, 0);
  const resumed = await runtime.inspectLiveAssignment(assignment, active.cursor);
  assert.deepEqual(streams, [undefined, "1"]);
  assert.equal(resumed.cursor.seq, 2);
  assert.equal(resumed.snapshot.output.text, "x".repeat(runtimeOutputLimit - 4) + "tail");
  assert.equal(resumed.snapshot.output.truncated, true);
});

test("overview keeps usage and expired or unsupported live output explicitly unavailable", async (t) => {
  const absent = await fixture(t, { noStream: true });
  const unavailable = await absent.runtime.inspectLiveAssignment(absent.assignment);
  assert.equal(unavailable.usage.metering, "unknown");
  assert.equal(unavailable.snapshot.output.availability, "unavailable");
  assert.match(unavailable.snapshot.output.reason, /run_events_sse/);
  assert.deepEqual(absent.streams, []);

  const expired = await fixture(t, { expired: true });
  const receipt = await expired.runtime.inspectLiveAssignment(expired.assignment);
  assert.match(receipt.snapshot.output.reason, /stream/);
});

test("overview rejects SSE frames belonging to another native run", async (t) => {
  const { runtime, assignment } = await fixture(t, { foreign: true });
  await assert.rejects(runtime.inspectLiveAssignment(assignment), { code: "assignment_mismatch" });
});

test("a replay gap stays explicit across an empty output window and reconnect", async (t) => {
  const { runtime, assignment, streams } = await fixture(t, { replayGap: true });
  const empty = await runtime.inspectLiveAssignment(assignment);
  assert.equal(empty.cursor.truncated, true);
  assert.equal(empty.snapshot.output.availability, "unavailable");
  const later = await runtime.inspectLiveAssignment(assignment, empty.cursor);
  assert.deepEqual(streams, [undefined, "3"]);
  assert.deepEqual(later.snapshot.output, { availability: "available", text: "retained output", truncated: true });
});
