import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defaultSettings } from "@praxis/settings";
import { startHermesFixture, until } from "./runtime/hermes-fixture.mjs";

const execute = promisify(execFile);
const manager = "fixture-manager-token-for-project-memory";
const worker = "fixture-worker-token-without-project-memory";
const entry = "packages/mcp/dist/cli.js";
const projectId = "catalog";
const decision = {
  projectId, noteId: "use-sqlite", kind: "decision", title: "Use SQLite for operational state",
  body: "Keep operational state separate from engineering notes.",
};
const finding = {
  projectId, noteId: "restore-check", kind: "finding", title: "Verified restart behavior",
  body: "Restarting the manager keeps saved project knowledge available.",
  verification: "The restart check passed and the same Markdown note was retrieved.",
  relatedNoteIds: [decision.noteId],
};

function grant(principalId, token, memoryProjects) {
  return {
    principalId, tokenDigest: createHash("sha256").update(token).digest("hex"), taskIds: [], sessions: [], actionKinds: [],
    ...(memoryProjects && { memoryProjects }),
  };
}

const tool = async (client, name, input) => {
  const result = await client.callTool({ name, arguments: input });
  return { error: Boolean(result.isError), ...result.structuredContent };
};

async function setup(t, memory = true) {
  const root = await mkdtemp(join(tmpdir(), "praxis-project-memory-test-"));
  const authorityFile = join(root, "authority.json");
  const settingsFile = join(root, "settings.json");
  const vault = join(root, "vault");
  const database = join(root, "state.sqlite");
  const env = { PATH: process.env.PATH, PRAXIS_CONFIG_FILE: settingsFile, PRAXIS_MCP_CONFIG_FILE: authorityFile, PRAXIS_MCP_PORT: "0" };
  const processes = new Set();
  const clients = new Set();
  async function stop(child) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    processes.delete(child);
  }
  t.after(async () => {
    await Promise.all([...clients].map((client) => client.close()));
    await Promise.all([...processes].map(stop));
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(authorityFile, JSON.stringify({
    schemaVersion: 1, database, ...(memory && { memory: { directory: vault } }),
    grants: [
      grant("principal_manager", manager, memory ? [{ projectId, canWrite: true }, { projectId: "read-only", canWrite: false }] : undefined),
      grant("principal_worker", worker),
    ],
  }));
  const setEnabled = (enabled) => writeFile(settingsFile, JSON.stringify({ ...defaultSettings(), memory: { enabled } }));
  await setEnabled(true);

  return {
    database, root, vault, setEnabled,
    local: (...args) => execute(process.execPath, [entry, "memory", ...args], { env, timeout: 3_000 }),
    async start() {
      const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
      processes.add(child);
      let log = "";
      child.stderr.on("data", (part) => { log += part; });
      const url = await Promise.race([
        once(child.stdout, "data").then(([part]) => /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(String(part))?.[0]),
        once(child, "close").then(() => { throw new Error("The built MCP process exited before listening. " + log); }),
      ]);
      assert.ok(url);
      return {
        url,
        stop: () => stop(child),
        async connect(token = manager) {
          const client = new Client({ name: "praxis-memory-fixture", version: "1.0" });
          clients.add(client);
          await client.connect(new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: { Authorization: "Bearer " + token } },
          }));
          return client;
        },
      };
    },
  };
}

test("the built MCP manager stores Markdown records and retrieves the scoped notes after restart", { timeout: 20_000 }, async (t) => {
  const fixture = await setup(t);
  let server = await fixture.start();
  let client = await server.connect();
  const listed = await client.listTools();
  assert.ok(listed.tools.some(({ name }) => name === "record_memory"));
  assert.equal((await tool(client, "record_memory", decision)).write, "inserted");
  assert.equal((await tool(client, "record_memory", finding)).write, "inserted");

  const markdown = await readFile(join(fixture.vault, projectId, "restore-check.md"), "utf8");
  assert.match(markdown, /^---\n/);
  assert.match(markdown, /^# Verified restart behavior$/m);
  assert.match(markdown, /\[use-sqlite\]\(\.\/use-sqlite\.md\)/);
  assert.match(markdown, /The restart check passed/);
  assert.doesNotMatch(markdown, /file:\/\/|operational\.sqlite/);
  assert.deepEqual((await readdir(join(fixture.vault, projectId))).sort(), ["restore-check.md", "use-sqlite.md"]);

  const other = await server.connect(worker);
  assert.equal((await other.listTools()).tools.some(({ name }) => name.endsWith("_memory")), false);
  assert.equal((await tool(other, "retrieve_memory", { projectId })).error, true);
  assert.equal((await tool(client, "retrieve_memory", { projectId: "ungranted" })).code, "forbidden");
  assert.equal((await tool(client, "record_memory", { ...decision, projectId: "read-only" })).code, "forbidden");
  assert.equal((await tool(client, "record_memory", { ...finding, noteId: "bad-finding", verification: undefined })).error, true);
  assert.equal((await tool(client, "record_memory", { ...decision, noteId: "unlinked", relatedNoteIds: ["missing"] })).error, true);
  assert.equal((await tool(client, "record_memory", { ...decision, noteId: "../../escape" })).error, true);

  await server.stop();
  server = await fixture.start();
  client = await server.connect();
  const recovered = await tool(client, "retrieve_memory", { projectId, query: "Restarting" });
  assert.deepEqual(recovered.notes.map(({ id, relativePath }) => [id, relativePath]), [["restore-check", "catalog/restore-check.md"]]);
  const note = (await tool(client, "retrieve_memory", { projectId, noteId: decision.noteId })).notes[0];
  assert.equal(note.body, decision.body);

  await fixture.setEnabled(false);
  assert.equal((await tool(client, "retrieve_memory", { projectId })).code, "disabled");
  assert.equal((await tool(client, "record_memory", { ...decision, noteId: "disabled" })).code, "disabled");
  assert.equal(await readFile(join(fixture.vault, projectId, "restore-check.md"), "utf8"), markdown);

  const exported = join(fixture.root, "exported");
  await fixture.local("export", exported);
  assert.deepEqual(await readdir(exported), [projectId]);
  assert.equal(await readFile(join(exported, projectId, "restore-check.md"), "utf8"), markdown);
  await assert.rejects(fixture.local("export", exported));
  assert.equal(JSON.parse((await fixture.local("prune", "2000-01-01")).stdout).removed, 0);
  assert.equal(JSON.parse((await fixture.local("prune", "2099-01-01")).stdout).removed, 2);
  await fixture.setEnabled(true);
  assert.deepEqual((await tool(client, "retrieve_memory", { projectId })).notes, []);

  const state = new DatabaseSync(fixture.database, { readOnly: true });
  try { assert.equal(state.prepare("SELECT count(*) AS records FROM operational_records").get().records, 0); }
  finally { state.close(); }
});

test("two MCP processes serialize valid writes and keep retries idempotent", { timeout: 20_000 }, async (t) => {
  const fixture = await setup(t);
  const server = await fixture.start();
  const second = await fixture.start();
  const [firstClient, secondClient] = await Promise.all([server.connect(), second.connect()]);
  const observer = await second.connect(worker);
  const [first, retry] = await Promise.all([
    tool(firstClient, "record_memory", decision), tool(secondClient, "record_memory", decision),
  ]);
  assert.deepEqual([first.write, retry.write].sort(), ["duplicate", "inserted"]);
  const lock = new DatabaseSync(join(fixture.vault, ".praxis-memory.lock"));
  lock.exec("BEGIN IMMEDIATE");
  const blockedPath = join(fixture.vault, projectId, "waiting.md");
  const waiting = tool(secondClient, "record_memory", { ...decision, noteId: "waiting" });
  try {
    assert.equal(await Promise.race([waiting.then(() => false), delay(250, true)]), true);
    await assert.rejects(readFile(blockedPath), { code: "ENOENT" });
    const responsive = await Promise.race([observer.listTools().then(() => true), delay(700, false)]);
    assert.equal(responsive, true, "A memory lock wait must leave unrelated MCP requests responsive");
  } finally { lock.close(); }
  assert.equal((await waiting).write, "inserted");
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => tool(index % 2 ? firstClient : secondClient, "record_memory", {
    ...decision, noteId: "parallel-" + index, title: "Parallel decision " + index,
  })));
  assert.ok(results.every(({ write }) => write === "inserted"));
  const changed = await tool(secondClient, "record_memory", { ...decision, body: "A conflicting update" });
  assert.equal(changed.code, "identity_conflict");
  assert.equal((await tool(firstClient, "retrieve_memory", { projectId })).notes.length, 14);
  const candidate = join(fixture.root, "owner-file");
  await writeFile(candidate, "Private external file");
  await symlink(candidate, join(fixture.vault, projectId, "linked.md"));
  assert.equal((await tool(firstClient, "retrieve_memory", { projectId, noteId: "linked" })).error, true);
  assert.equal((await tool(firstClient, "record_memory", { ...decision, noteId: "linked" })).error, true);
  assert.equal(await readFile(candidate, "utf8"), "Private external file");
});

test("memory acknowledges a published note while another process has a SQLite read transaction", { timeout: 10_000 }, async (t) => {
  const fixture = await setup(t);
  const client = await (await fixture.start()).connect();
  assert.equal((await tool(client, "record_memory", decision)).write, "inserted");

  const reader = new DatabaseSync(join(fixture.vault, ".praxis-memory.lock"));
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT name FROM sqlite_schema").all();
    const saved = await tool(client, "record_memory", finding);
    const markdown = await readFile(join(fixture.vault, projectId, finding.noteId + ".md"), "utf8");
    assert.ok(markdown.includes(finding.body));
    assert.equal(saved.write, "inserted");
    assert.equal((await tool(client, "record_memory", finding)).write, "duplicate");
  } finally { reader.close(); }
});

test("memory is opt-in and leaves ordinary MCP tools available", { timeout: 10_000 }, async (t) => {
  const fixture = await setup(t, false);
  const server = await fixture.start();
  const client = await server.connect();
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), [
    "inspect_task", "inspect_worker", "report_worker", "request_action",
  ]);
  await assert.rejects(readdir(fixture.vault), { code: "ENOENT" });
  await assert.rejects(fixture.local("export", join(fixture.root, "no-export")), /Opt in/);
});

test("pinned Hermes records and retrieves project memory through its native MCP client", {
  skip: !process.env.PRAXIS_HERMES_BIN, timeout: 90_000,
}, async (t) => {
  const fixture = await setup(t);
  const mcp = await fixture.start();
  const record = "mcp__praxis__record_memory";
  const retrieve = "mcp__praxis__retrieve_memory";
  const final = "Hermes retrieved the scoped project decision.";
  let observed = false;
  const { runtime } = await startHermesFixture(t, (call) => {
    const toolResults = call.messages.filter(({ role }) => role === "tool");
    if (toolResults.length >= 2) {
      observed = JSON.stringify(toolResults.at(-1).content).includes(decision.body);
      return { message: { role: "assistant", content: observed ? final : "The expected memory was absent." } };
    }
    const name = toolResults.length === 0 ? record : retrieve;
    const args = name === record ? decision : { projectId, noteId: decision.noteId };
    const names = call.tools?.map(({ function: tool }) => tool?.name) ?? [];
    const direct = names.includes(name);
    if (!direct && !names.includes("tool_call")) return { message: { role: "assistant", content: "The memory tool was unavailable." } };
    return { finishReason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
      id: name, type: "function", function: {
        name: direct ? name : "tool_call", arguments: JSON.stringify(direct ? args : { calls: [{ name, arguments: args }] }),
      },
    }] } };
  }, [
    "mcp_servers:", "  praxis:", `    url: "${mcp.url}"`, "    headers:", `      Authorization: "Bearer ${manager}"`,
  ]);
  const assignment = await runtime.createAssignment({ schemaVersion: 1, id: "session_memory", taskId: "task_memory" },
    "Save the isolated decision and retrieve it using Praxis project memory.");
  const complete = await until(async () => {
    const snapshot = await runtime.inspectAssignment(assignment);
    if (snapshot.status === "failed") assert.fail("The native Hermes memory run failed");
    return snapshot.status === "completed" && snapshot;
  }, "The native Hermes memory run did not complete");
  assert.equal(observed, true);
  assert.deepEqual(complete.output, { availability: "available", text: final, truncated: false });
  assert.ok((await readFile(join(fixture.vault, projectId, decision.noteId + ".md"), "utf8")).includes(decision.body));
});
