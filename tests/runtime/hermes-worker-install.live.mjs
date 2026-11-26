import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { createPraxisMcpServer } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";
import { providerFixture, stopProcess, until } from "./hermes-fixture.mjs";

const run = promisify(execFile);
const installer = fileURLToPath(new URL("../../scripts/install-hermes-worker.mjs", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const tool = (name) => `mcp__praxis__${name}`;
const allowed = ["inspect_task", "inspect_worker", "report_worker"].map(tool);
const blocked = ["terminal", "execute_code", "write_file", "skill_manage", "delegate_task",
  ...["request_action", "record_memory", "inspect_skill_proposals", "request_skill_review", "decide_skill_proposal"].map(tool)];

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function modelReply(content) {
  return { message: { role: "assistant", content } };
}

function toolReply(id, name, args) {
  return { finishReason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id: `call_${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  } };
}

test("two installed native workers report concurrently and stay isolated with no manager", { timeout: 150_000 }, async (t) => {
  const binary = process.env.PRAXIS_HERMES_BIN;
  const axiom = process.env.PRAXIS_AXIOM_ROOT;
  assert.ok(binary && axiom, "Set PRAXIS_HERMES_BIN and PRAXIS_AXIOM_ROOT to the pinned source builds.");
  const { inspectHermesActivation } = await import(pathToFileURL(join(axiom, "adapters/hermes/dist/index.js")));
  const directory = await mkdtemp(join(tmpdir(), "praxis-native-worker-"));
  const user = join(directory, "user");
  await mkdir(user);
  const env = { HOME: user, PATH: process.env.PATH, HERMES_DISABLE_LAZY_INSTALLS: "1", HERMES_NO_SYSTEMD: "1", TERM: "dumb" };
  const store = new OperationalStore(join(directory, "operational.sqlite"));
  const hold = Promise.withResolvers();
  const workers = ["first", "second"].map((id) => ({
    id, profile: `fixture-worker-${id}`, home: join(directory, id),
    task: { schemaVersion: 1, id: `task_worker_${id}`, title: `Fixture task ${id}` },
    session: { schemaVersion: 1, id: `session_worker_${id}`, taskId: `task_worker_${id}` },
    principal: `principal_worker_${id}`, mcpKey: token(), apiKey: token(),
    fact: `A distinct observation for the ${id} worker.`,
    proposal: `Skill proposal for the ${id} worker with fixture evidence.`,
    seen: new Set(), reachedReport: false, ownReport: false, deniedForeignReport: false,
    sawOwnProfile: false, sawOtherProfile: false, sawOwnHistory: false,
  }));
  let mcp;
  t.after(async () => {
    hold.resolve();
    await Promise.all(workers.map(async ({ gateway, provider, client }) => {
      await client?.close();
      await stopProcess(gateway);
      await provider?.close();
    }));
    if (mcp?.listening) await close(mcp);
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });

  const version = await run(binary, ["--version"], { env: { ...env, HERMES_HOME: join(directory, "version") }, timeout: 15_000 });
  assert.match(version.stdout, /^Hermes Agent v0\.23\.3\b/m);
  const source = /^Install directory:\s*(.+)$/m.exec(version.stdout)?.[1];
  assert.ok(source, "The fixture needs a pinned Hermes source installation.");
  assert.equal((await run("git", ["-C", source, "rev-parse", "HEAD"], { env })).stdout.trim(), "caafe5389ae585ef77387a962aee05b1bcf17029");
  t.diagnostic(version.stdout.split("\n").filter((line) => /^(Hermes Agent|Python:)/.test(line)).join("\n"));

  for (const { task, session } of workers) {
    store.recordTask(task);
    store.recordSession(session);
  }
  mcp = createPraxisMcpServer({ store, grants: workers.map((worker) => ({
    principalId: worker.principal, tokenDigest: digest(worker.mcpKey), taskIds: [worker.task.id],
    sessions: [{ sessionId: worker.session.id, canReport: true }], actionKinds: [],
  })) });
  const endpoint = `http://127.0.0.1:${await listen(mcp)}/mcp`;

  for (const worker of workers) {
    const other = workers.find((candidate) => candidate !== worker);
    const setup = await run(process.execPath, [installer, "--hermes-bin", binary, "--hermes-home", worker.home,
      "--profile", worker.profile, "--axiom-root", axiom, "--mcp-origin", endpoint], { env, timeout: 45_000 });
    const installed = JSON.parse(setup.stdout);
    assert.equal(installed.profile, worker.profile);
    assert.equal(installed.policy.status, "enabled");
    const profileHome = join(worker.home, "profiles", worker.profile);
    const soul = join(profileHome, "SOUL.md");
    assert.match(await readFile(soul, "utf8"), /# Praxis worker/);
    await appendFile(soul, `\nProfile marker for ${worker.id} only.\n`);
    worker.provider = await providerFixture((call) => {
      const lastUser = call.messages.findLastIndex(({ role }) => role === "user");
      const input = call.messages[lastUser]?.content;
      const names = call.tools?.map(({ function: definition }) => definition.name) ?? [];
      if (!names.length) return modelReply("Worker fixture title");
      const system = call.messages.filter(({ role }) => role === "system").map(({ content }) => content).join("\n");
      worker.sawOwnProfile ||= system.includes(`Profile marker for ${worker.id} only.`);
      worker.sawOtherProfile ||= system.includes(`Profile marker for ${other.id} only.`);
      if (input === "Recall your fixture observation.") {
        const history = JSON.stringify(call.messages.slice(0, lastUser));
        worker.sawOwnHistory = history.includes(worker.fact) && !history.includes(other.fact);
        return modelReply("The worker retained its own conversation.");
      }
      if (input !== worker.fact) return modelReply("Unexpected fixture input.");
      for (const name of names) worker.seen.add(name);
      const results = call.messages.slice(lastUser + 1).filter(({ role }) => role === "tool");
      const observed = JSON.stringify(results);
      const report = { sessionId: worker.session.id, phase: "result", message: worker.proposal,
        occurredAt: "2026-11-26T10:00:00Z", submissionId: "event_praxis_worker_proposal" };
      if (!worker.reachedReport) {
        worker.reachedReport = true;
        return { ...toolReply("own_report", tool("report_worker"), report), holdAfterMessage: hold.promise };
      }
      if (!worker.ownReport) {
        worker.ownReport = observed.includes(worker.principal);
        if (!worker.ownReport) return modelReply("The worker could not record its report.");
        return toolReply("foreign_report", tool("report_worker"), { ...report, sessionId: other.session.id, submissionId: "event_foreign_worker_report" });
      }
      worker.deniedForeignReport = observed.includes("forbidden");
      return modelReply("The worker completed with its scoped permissions.");
    });

    await appendFile(join(profileHome, "config.yaml"), ["", "model:", "  provider: custom",
      `  base_url: ${worker.provider.origin}`, "  default: fake-model", "  api_key: fixture-only", "  context_length: 128000", ""].join("\n"));
    await writeFile(join(profileHome, ".env"), `API_SERVER_KEY=${worker.apiKey}\nPRAXIS_MCP_TOKEN=${worker.mcpKey}\n`, { mode: 0o600 });
    const reservation = createServer();
    const port = await listen(reservation);
    await close(reservation);
    worker.gateway = spawn(binary, ["-p", worker.profile, "gateway", "run"], { cwd: directory, stdio: "ignore", env: {
      ...env, HERMES_HOME: worker.home, API_SERVER_ENABLED: "true", API_SERVER_HOST: "127.0.0.1", API_SERVER_PORT: String(port),
    } });
    worker.origin = `http://127.0.0.1:${port}/p/${worker.profile}`;
    worker.runtime = new HermesRuntime({ origin: worker.origin, apiKey: worker.apiKey });
    await until(async () => {
      assert.equal(worker.gateway.exitCode, null, "The worker gateway exited during startup.");
      try { return (await worker.runtime.capabilities()).submission.available; }
      catch (error) { if (error.code === "unavailable") return false; throw error; }
    }, "The worker did not start its authenticated native route.");
  }

  await Promise.all(workers.map(async (worker) => {
    worker.assignment = await worker.runtime.submitTurn(worker.session, worker.fact, "first");
  }));
  await until(() => workers.every((worker) => worker.reachedReport), "Both independent native runs did not reach the provider concurrently.");
  for (const worker of workers) assert.equal((await worker.runtime.inspectAssignment(worker.assignment)).status, "running");
  hold.resolve();

  async function completed(worker, assignment) {
    return until(async () => {
      const snapshot = await worker.runtime.inspectAssignment(assignment);
      assert.notEqual(snapshot.status, "failed", "The native worker run failed.");
      return snapshot.status === "completed" && snapshot;
    }, "The native worker run did not complete.");
  }

  for (const worker of workers) {
    const other = workers.find((candidate) => candidate !== worker);
    const complete = await completed(worker, worker.assignment);
    assert.equal(complete.output.text, "The worker completed with its scoped permissions.");
    assert.ok(worker.sawOwnProfile && !worker.sawOtherProfile, "Hermes loaded only the selected worker personality.");
    assert.deepEqual([...worker.seen].filter((name) => name.startsWith("mcp__praxis__")).sort(), [...allowed].sort());
    assert.ok(blocked.every((name) => !worker.seen.has(name)), "Mutation and execution tools are absent from the native profile.");
    assert.ok(worker.ownReport && worker.deniedForeignReport, "The native worker can report only for its own scope.");
    assert.deepEqual(store.eventsFor(worker.session.id).map(({ details }) => details), [
      { type: "worker_report", actorId: worker.principal, message: worker.proposal },
    ]);

    const receipt = await fetch(`${worker.origin}/v1/runs/${worker.assignment.runId}`, { headers: { Authorization: `Bearer ${worker.apiKey}` } });
    assert.equal(receipt.status, 200);
    const session = (await receipt.json()).session_id;
    assert.equal(inspectHermesActivation({ home: worker.home, profile: worker.profile }, session).loaded.status, "passed");
    const foreign = await fetch(`${worker.origin}/v1/runs/${other.assignment.runId}`, { headers: { Authorization: `Bearer ${worker.apiKey}` } });
    assert.equal(foreign.status, 404);
    await foreign.body?.cancel();
    const wrongKey = await fetch(`${worker.origin}/v1/capabilities`, { headers: { Authorization: `Bearer ${other.apiKey}` } });
    assert.equal(wrongKey.status, 401);
    await wrongKey.body?.cancel();

    worker.client = new Client({ name: "worker-permissions-fixture", version: "1.0.0" });
    await worker.client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${worker.mcpKey}` } },
    }));
    const request = await worker.client.callTool({ name: "request_action", arguments: {
      kind: "session.stop", target: { kind: "session", id: worker.session.id },
      occurredAt: "2026-11-26T10:00:00Z", submissionId: "event_ungranted_action",
    } });
    assert.equal(request.structuredContent?.code, "forbidden");
    const followUp = await worker.runtime.submitTurn(worker.session, "Recall your fixture observation.", "follow-up");
    assert.equal((await completed(worker, followUp)).output.text, "The worker retained its own conversation.");
    assert.equal(worker.sawOwnHistory, true);
  }
  assert.equal(store.eventsOfKind("action.requested").length, 0);
  t.diagnostic("Both named native workers loaded Axiom, reported with separate credentials, and rejected out-of-scope reports, foreign runs, cross-profile credentials and action requests without a manager.");
});
