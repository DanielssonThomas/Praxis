import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const corePolicy = {
  version: "1",
  digest: "sha256:2e968204a73b3d6384af8ff0687c8126c3ef798725f4d566ccbf655151ebcc78",
  profiles: [],
};
const briefFor = (id) => ({
  id, objective: "Review the disposable fixture and report its label without changing the file.",
  ownedPaths: ["fixture.txt"], policy: corePolicy, requiredCapabilities: ["process-execution", "policy-loading"],
  criteria: [{ id: "preserved", description: "Keep fixture.txt as staged.", required: true }],
  limits: { timeoutMs: 15_000, maxAttempts: 1, maxConcurrency: 1 },
});
const requestFor = (name) => {
  const task = { schemaVersion: 1, id: "task_" + name, title: "Fixture " + name };
  const session = { schemaVersion: 1, id: "session_" + name, taskId: task.id };
  return { task, session, brief: briefFor(task.id) };
};
const frame = (event) => "data: " + JSON.stringify(event) + "\n\n";
async function deadline(promise, message) {
  const abort = new AbortController();
  try {
    return await Promise.race([promise, delay(10_000, undefined, { signal: abort.signal })
      .then(() => { throw new Error(message); })]);
  } finally {
    abort.abort();
  }
}

test("the pinned Codex worker reads its workspace, delivers policy and observes the scoped lifecycle", { timeout: 60_000 }, async (t) => {
  assert.ok(process.env.PRAXIS_CODEX_BIN && process.env.PRAXIS_AXIOM_ROOT, "Set PRAXIS_CODEX_BIN and PRAXIS_AXIOM_ROOT");
  const { CodexExecutor } = await import("../../packages/codex-runtime/dist/index.js");
  const { runtimeOutputLimit } = await import("@praxis/contracts");
  const root = await mkdtemp(join(tmpdir(), "praxis-codex-live-"));
  const source = process.env.PRAXIS_AXIOM_ROOT;
  const core = (await readFile(join(source, "core/AXIOMS.md"), "utf8")).trimEnd();
  const cancelled = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const outputSent = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const deliveries = [];
  const marker = "native-fixture-" + randomUUID();
  const fixture = marker + "\n";
  const readCall = "read-scoped-fixture";
  const padding = "0123456789".repeat(1_800) + "\n";
  const output = padding + marker;
  let fixtureFailure;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/responses");
      assert.equal(request.headers.authorization, undefined);
      const chunks = [];
      for await (const bytes of request) chunks.push(bytes);
      const body = JSON.parse(Buffer.concat(chunks));
      const toolResult = body.input.find(({ type, call_id }) => type === "custom_tool_call_output" && call_id === readCall);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (!toolResult) {
        const userMessages = body.input.filter(({ type, role }) => type === "message" && role === "user")
          .flatMap(({ content }) => content).map(({ text }) => text);
        const text = userMessages.at(-1);
        const brief = JSON.parse(text.slice(text.indexOf("\n") + 1));
        assert.deepEqual(brief, briefFor(brief.id));
        assert.ok(userMessages.slice(0, -1).some((item) => item.includes(`Axiom policy digest: ${corePolicy.digest}\n\n${core}`)));
        deliveries.push(brief.id);
        if (brief.id === "task_complete") {
          assert.ok(body.tools?.some(({ name }) => name === "exec"), "The native worker must advertise Code Mode exec.");
          const id = "response-workspace-read";
          const item = { type: "custom_tool_call", call_id: readCall, name: "exec", input: `
            const result = await tools.exec_command({ cmd: "cat -- fixture.txt" });
            if (result.exit_code !== 0) throw new Error("Workspace read failed.");
            text(result.output);
          ` };
          response.write(frame({ type: "response.created", response: { id } }));
          response.write(frame({ type: "response.output_item.done", item }));
          response.end(frame({ type: "response.completed", response: {
            id, status: "completed", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          } }));
          return;
        }
        assert.equal(brief.id, "task_cancel");
        response.write(frame({ type: "response.created", response: { id: "response-cancel" } }));
        response.once("close", disconnected.resolve);
        cancelled.resolve();
        return;
      }
      const textItems = Array.isArray(toolResult.output) ? toolResult.output.map(({ text }) => text) : [toolResult.output];
      const fixtureLine = textItems.find((text) => text === marker || text === fixture);
      const missingHost = textItems.some((text) => typeof text === "string" && text.includes("codex-code-mode-host")
        && /code.mode.{0,60}(unavailable|not found|missing)/i.test(text));
      assert.ok(fixtureLine, missingHost
        ? "Code Mode could not find codex-code-mode-host. Set PRAXIS_CODEX_BIN to bin/codex in the complete pinned package."
        : "The native workspace command must exit successfully and return the exact staged marker as a whole line.");
      const id = "response-report";
      const report = padding + fixtureLine.replace(/\n$/, "");
      const message = { id: "message-report", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: report, annotations: [] }] };
      response.write(frame({ type: "response.created", response: { id } }));
      response.write(frame({ type: "response.output_item.added", item: { ...message, content: [], status: "in_progress" } }));
      response.write(frame({ type: "response.output_text.delta", delta: report, item_id: message.id, output_index: 0, content_index: 0 }));
      response.write(frame({ type: "response.output_item.done", item: message }));
      outputSent.resolve();
      await finish.promise;
      response.end(frame({ type: "response.completed", response: {
        id, status: "completed", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      } }));
    } catch (error) {
      fixtureFailure = error;
      outputSent.resolve();
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    finish.resolve();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const codex = new CodexExecutor({
    program: process.env.PRAXIS_CODEX_BIN, axiomRoot: source, root, model: "gpt-5.4",
    prepareProfile: ({ codexHome }) => writeFile(join(codexHome, "config.toml"), [
      'model_provider = "fixture"', "[features]", "code_mode_only = true",
      "[code_mode]", "disable_in_process_fallback = true",
      "[model_providers.fixture]", 'name = "Disposable localhost"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`, 'wire_api = "responses"',
      "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 0",
    ].join("\n")),
    prepareWorkspace: ({ workspace }) => writeFile(join(workspace, "fixture.txt"), fixture),
    authorizeLaunch: async ({ task }) => {
      if (task.id === "task_denied_at_start") throw new Error("The fixture approval became stale after staging.");
    },
  });
  const host = await codex.capabilities();
  assert.deepEqual(host.host, { runtime: "codex", version: "0.172.0-alpha.2", os: "linux", architecture: "x64", surface: "cli" });
  assert.ok(host.launch.available && host.output.available && host.cancellation.available && host.completion.available);
  const unsupported = requestFor("unsupported");
  unsupported.brief.requiredCapabilities = ["delegation"];
  await assert.rejects(codex.createAssignment(unsupported), { code: "unsupported" });
  const unrelated = requestFor("unrelated");
  unrelated.brief.id = "task_different";
  await assert.rejects(codex.createAssignment(unrelated), { code: "invalid_input" });
  await assert.rejects(codex.createAssignment(requestFor("denied_at_start")), { code: "unavailable" });
  const attempts = await Promise.all([codex.createAssignment(requestFor("complete")), codex.createAssignment(requestFor("cancel"))]);
  const [complete, stop] = attempts;

  await deadline(cancelled.promise, "The second native task did not reach the localhost provider");
  await deadline(outputSent.promise, "The first worker did not reach the scripted output");
  if (fixtureFailure) throw fixtureFailure;
  const live = await deadline((async () => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const current = codex.inspectAssignment(complete).snapshot;
      if (current.output.availability === "available") return current;
      await delay(25);
    }
    throw new Error("The executor did not expose native output before turn completion");
  })(), "The executor did not expose native output before turn completion");
  assert.equal(live.status, "running");
  assert.deepEqual(live.output, { availability: "available", text: output.slice(-runtimeOutputLimit), truncated: true });
  finish.resolve();
  assert.equal(codex.inspectAssignment(stop).snapshot.status, "running");
  assert.throws(() => codex.inspectAssignment({ ...stop, taskId: complete.taskId }), { code: "assignment_mismatch" });
  const taskId = stop.taskId;
  stop.taskId = complete.taskId;
  assert.throws(() => codex.stopAssignment(stop), { code: "assignment_mismatch" });
  stop.taskId = taskId;
  assert.equal(codex.stopAssignment(stop).snapshot.status, "stopping");
  const [finished, stopped] = await deadline(Promise.all(attempts.map((assignment) => codex.waitAssignment(assignment))), "The native tasks did not settle");
  await deadline(disconnected.promise, "The native provider stream did not close after cancellation");
  if (fixtureFailure) throw fixtureFailure;
  assert.equal(finished.snapshot.status, "completed");
  assert.deepEqual(finished.snapshot.output, { availability: "available", text: output.slice(-runtimeOutputLimit), truncated: true });
  assert.deepEqual({ metering: finished.usage.metering, inputTokens: finished.usage.inputTokens, outputTokens: finished.usage.outputTokens },
    { metering: "reported", inputTokens: 10, outputTokens: 3 });
  assert.equal(stopped.snapshot.status, "stopped");
  assert.equal(stopped.usage.metering, "unknown");
  assert.deepEqual(deliveries.sort(), ["task_cancel", "task_complete"]);
  const paths = attempts.map((assignment) => codex.workspaceFor(assignment));
  assert.notEqual(paths[0], paths[1]);
  for (const workspace of paths) {
    assert.deepEqual(await readdir(workspace), ["fixture.txt"]);
    assert.equal(await readFile(join(workspace, "fixture.txt"), "utf8"), fixture);
  }
  t.diagnostic("Real isolated Codex CLI workspace read, completion and metering, exact policy and brief delivery, bounded output and active cancellation passed.");
});
