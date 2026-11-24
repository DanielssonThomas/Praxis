import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationalStore } from "@praxis/state";
import { startHermesFixture, stopProcess, until } from "./hermes-fixture.mjs";

const task = { schemaVersion: 1, id: "task_native_mcp", title: "Authenticated Praxis MCP fixture task" };
const toolName = "mcp__praxis__inspect_task";
const verifiedAnswer = "Hermes received the authorized Praxis task.";

function modelReply(content) {
  return { message: { role: "assistant", content } };
}

test("real Hermes invokes a Praxis MCP tool through its native authenticated client", { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-native-mcp-"));
  const configPath = join(directory, "mcp-authority.json");
  const database = join(directory, "state.sqlite");
  const token = randomBytes(32).toString("base64url");
  let mcp;
  t.after(async () => {
    await stopProcess(mcp);
    await rm(directory, { recursive: true, force: true });
  });

  const store = new OperationalStore(database);
  store.recordTask(task);
  store.close();
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    database,
    grants: [{
      principalId: "principal_native_hermes",
      tokenDigest: createHash("sha256").update(token).digest("hex"),
      taskIds: [task.id],
      sessions: [],
      actionKinds: [],
    }],
  }), { mode: 0o600 });

  mcp = spawn(process.execPath, ["packages/mcp/dist/cli.js"], {
    env: { PATH: process.env.PATH, PRAXIS_MCP_PORT: "0", PRAXIS_MCP_CONFIG_FILE: configPath },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const log = await Promise.race([
    once(mcp.stdout, "data").then(([chunk]) => chunk.toString()),
    once(mcp, "exit").then(() => { throw new Error("Praxis MCP exited before listening"); }),
  ]);
  const mcpUrl = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(log)?.[0];
  assert.ok(mcpUrl, "Praxis printed its local MCP endpoint");

  let observedToolResult = false;
  const { runtime } = await startHermesFixture(t, (call) => {
    const toolResults = call.messages.filter(({ role }) => role === "tool");
    if (toolResults.length > 0) {
      observedToolResult = toolResults.some(({ content }) => JSON.stringify(content)?.includes(task.title));
      return modelReply(observedToolResult ? verifiedAnswer : "The expected task was absent from the MCP result.");
    }

    const names = call.tools?.map(({ function: tool }) => tool?.name) ?? [];
    const direct = names.includes(toolName);
    if (!direct && !names.includes("tool_call")) return modelReply("Hermes did not advertise MCP tool invocation.");
    const args = { taskId: task.id };
    return {
      finishReason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_praxis_fixture",
          type: "function",
          function: {
            name: direct ? toolName : "tool_call",
            arguments: JSON.stringify(direct ? args : { calls: [{ name: toolName, arguments: args }] }),
          },
        }],
      },
    };
  }, [
    "mcp_servers:",
    "  praxis:",
    `    url: "${mcpUrl}"`,
    "    headers:",
    `      Authorization: "Bearer ${token}"`,
  ]);

  const assignment = await runtime.createAssignment({
    schemaVersion: 1, id: "session_native_mcp", taskId: task.id,
  }, "Read the isolated Praxis fixture via its MCP task inspector.");
  const complete = await until(async () => {
    const snapshot = await runtime.inspectAssignment(assignment);
    if (snapshot.status === "failed") assert.fail("The native Hermes MCP run failed");
    return snapshot.status === "completed" ? snapshot : false;
  }, "Hermes did not finish its MCP turn");

  assert.equal(observedToolResult, true);
  assert.deepEqual(complete.output, { availability: "available", text: verifiedAnswer, truncated: false });
  t.diagnostic("The real Hermes client authenticated, discovered the tool and returned the SQLite-backed task to the model turn.");
});
