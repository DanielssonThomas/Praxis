import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ManagementService } from "@praxis/management";
import { OperationalStore } from "@praxis/state";
import { skillEvaluation } from "../fixtures/skill-evaluation.mjs";
import { startHermesFixture, stopProcess, until } from "./hermes-fixture.mjs";

const findingKey = "stale-projection";
const skillId = "validate-projection";
const task = { schemaVersion: 1, id: "task_curation", title: "Verify a worker projection" };
const session = (name) => ({ schemaVersion: 1, id: "session_" + name, taskId: task.id });
const reports = session("reporting");
const reads = session("loading");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const grant = (role, credential, sessions = [], extra = {}) => ({
  principalId: "principal_curation_" + role, tokenDigest: hash(credential),
  taskIds: [task.id], sessions, actionKinds: [], ...extra,
});

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { error: Boolean(result.isError), ...result.structuredContent };
}

function toolReply(body, name, args) {
  const direct = body.tools?.some(({ function: fn }) => fn?.name === name);
  return { finishReason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
    id: "call_" + name, type: "function", function: {
      name: direct ? name : "tool_call", arguments: JSON.stringify(direct ? args : { calls: [{ name, arguments: args }] }),
    },
  }] } };
}

const reply = (content) => ({ message: { role: "assistant", content } });
const lastTool = ({ messages }) => messages.findLast(({ role }) => role === "tool");
const userMessages = ({ messages }) => messages.filter(({ role }) => role === "user").map(({ content }) => JSON.stringify(content));
const mcpConfig = (origin, credential) => [
  "mcp_servers:", "  praxis:", "    url: " + JSON.stringify(origin), "    headers:",
  "      Authorization: " + JSON.stringify("Bearer " + credential), "    trust: full",
];

async function completed(runtime, assignment) {
  return until(async () => {
    const observed = await runtime.inspectAssignment(assignment);
    return observed.status === "completed" ? observed : false;
  }, "The authenticated native Hermes fixture run did not complete.");
}

test("native Hermes workers propose and load selected knowledge and background review records usage", { timeout: 150_000 }, async (t) => {
  assert.ok(process.env.PRAXIS_AXIOM_ROOT, "Set PRAXIS_AXIOM_ROOT to the clean built Axiom checkout.");
  const directory = await mkdtemp(join(tmpdir(), "praxis-curation-live-"));
  const database = join(directory, "state.sqlite");
  const authority = join(directory, "authority.json");
  const store = new OperationalStore(database);
  let server;
  let curator;
  t.after(async () => {
    await curator?.close();
    await stopProcess(server);
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 2 });
  });
  store.recordTask(task);
  for (const record of [reports, reads]) store.recordSession(record);

  const workerKey = token();
  const backgroundKey = token();
  const curatorKey = token();
  const curatorGrant = grant("curator", curatorKey);
  const backgroundGrant = grant("background", backgroundKey, [], { canReviewSkills: true });
  const workerGrant = grant("worker", workerKey, [
    { sessionId: reports.id, canReport: true },
    { sessionId: reads.id, canReport: false, curatedSkills: [{ skillId, version: 1 }] },
  ]);
  await writeFile(authority, JSON.stringify({
    schemaVersion: 1, database, grants: [curatorGrant, backgroundGrant, workerGrant],
    skills: { directory: "curated", curatorPrincipalId: curatorGrant.principalId },
  }), { mode: 0o600 });
  server = spawn(process.execPath, ["packages/mcp/dist/cli.js"], {
    env: { ...process.env, PRAXIS_MCP_CONFIG_FILE: authority, PRAXIS_MCP_PORT: "0" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const origin = await Promise.race([
    once(server.stdout, "data").then(([chunk]) => /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(String(chunk))?.[0]),
    once(server, "exit").then(() => { throw new Error("Curated MCP stopped before listening."); }),
  ]);
  assert.ok(origin);
  curator = new Client({ name: "curation-fixture", version: "1" });
  await curator.connect(new StreamableHTTPClientTransport(new URL(origin), {
    requestInit: { headers: { Authorization: "Bearer " + curatorKey } },
  }));

  const skillMarker = randomUUID();
  const skillBody = "Compare the persisted and visible projection. Fixture marker " + skillMarker + ".";
  let observedLoad;
  const worker = await startHermesFixture(t, (body) => {
    if (!body.tools?.length) return reply("Fixture auxiliary response.");
    const inputs = userMessages(body);
    const result = lastTool(body);
    if (inputs.some((text) => text.includes("Submit one verified finding."))) {
      if (result) return reply("Finding submitted.");
      return toolReply(body, "mcp__praxis__propose_skill", {
        sessionId: reports.id, submissionId: "event_curation_native", findingKey,
        observation: "A live projection can show stale state after restart.",
        evidence: "The disposable fixture reproduced the prior value after the state changed.",
      });
    }
    if (inputs.some((text) => text.includes("Read the selected published workflow."))) {
      if (!result) {
        return toolReply(body, "mcp__praxis__load_curated_skill", {
          sessionId: reads.id, skillId, version: 1,
        });
      }
      observedLoad = JSON.stringify(result.content);
      return reply("Selected skill loaded.");
    }
    return reply("Fixture worker response.");
  }, mcpConfig(origin, workerKey));
  const report = await worker.runtime.createAssignment(reports, "Submit one verified finding.");
  assert.match((await completed(worker.runtime, report)).output.text, /Finding submitted/);
  const view = await call(curator, "inspect_skill_proposals", { findingKey });
  assert.equal(view.group.findings.length, 1);
  assert.equal(view.group.findings[0].sessionId, reports.id);
  const revision = view.group.revision;

  const review = await call(curator, "request_skill_review", { findingKey, revision, taskId: task.id });
  assert.equal(review.write, "inserted");
  let observedReview;
  const background = await startHermesFixture(t, (body) => {
    if (!body.tools?.length) return reply("Fixture auxiliary response.");
    if (!userMessages(body).some((text) => text.includes("axiom:knowledge"))) return reply("Fixture review response.");
    const result = lastTool(body);
    if (result) {
      observedReview = JSON.stringify(result.content);
      return reply("Verified a scoped finding and recommended one reusable procedure.");
    }
    return toolReply(body, "mcp__praxis__inspect_skill_proposals", { findingKey, revision });
  }, mcpConfig(origin, backgroundKey));
  const manager = new ManagementService({
    store, runtime: background.runtime, profile: background.origin, principalId: backgroundGrant.principalId,
    concurrency: 1, maxAttempts: 2, pollMs: 150, loadGrant: async () => backgroundGrant,
  });
  await until(async () => {
    await manager.advance();
    return store.management.list().find(({ work, state }) => work.id === review.workId && state === "completed");
  }, "Native maintenance review did not complete.");
  assert.ok(observedReview?.includes("The disposable fixture reproduced"));
  const work = store.management.list().find(({ work }) => work.id === review.workId);
  const usage = store.eventsOfKind("management.usage").map(({ subject }) => store.getUsage(subject.id));
  assert.equal(usage.length, 1);
  assert.equal(usage[0].sessionId, work.session.id);
  assert.equal(usage[0].metering, "reported");

  const draft = {
    skillId, description: "Verify a persisted projection from a fresh process.", body: skillBody,
    owner: "Fixture workflow maintainer", lifecycle: "Review when projection behavior changes.",
    verification: "The fixture detected the superseded visible result and passed after a fresh read.",
    evaluation: skillEvaluation(skillId),
  };
  const decision = {
    findingKey, revision, decision: "create", sourceInspected: "Operational tests and the curated catalog.",
    rationale: "One verification procedure belongs to the shared workflow.", draft,
  };
  const reserved = await call(curator, "decide_skill_proposal", { ...decision, draft: { ...draft, skillId: "knowledge" } });
  assert.equal(reserved.code, "invalid_skill");
  const wrongVersion = await call(curator, "decide_skill_proposal", {
    ...decision, draft: { ...draft, evaluation: skillEvaluation(skillId, 2) },
  });
  assert.equal(wrongVersion.code, "invalid_skill");
  const invalidEvaluation = await call(curator, "decide_skill_proposal", {
    ...decision, draft: { ...draft, evaluation: { ...draft.evaluation, principleIds: ["AX-90"] } },
  });
  assert.equal(invalidEvaluation.code, "invalid_skill");
  assert.deepEqual((await call(curator, "decide_skill_proposal", decision)).skill, { skillId, version: 1 });
  const load = await worker.runtime.createAssignment(reads, "Read the selected published workflow.");
  assert.match((await completed(worker.runtime, load)).output.text, /Selected skill loaded/);
  assert.ok(observedLoad?.includes(skillBody));
  assert.ok(!observedLoad.includes("The disposable fixture reproduced"));
  t.diagnostic("Native Hermes submitted the finding and loaded only published guidance. Its separate background review produced a native management usage receipt.");
});
