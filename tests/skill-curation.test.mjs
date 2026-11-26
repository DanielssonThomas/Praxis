import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as mcp from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";

const firstTask = { schemaVersion: 1, id: "task_fixture_one", title: "First fixture task" };
const secondTask = { schemaVersion: 1, id: "task_fixture_two", title: "Second fixture task" };
const outsideTask = { schemaVersion: 1, id: "task_outside", title: "Outside curation scope" };
const firstSession = { schemaVersion: 1, id: "session_fixture_one", taskId: firstTask.id };
const secondSession = { schemaVersion: 1, id: "session_fixture_two", taskId: secondTask.id };
const outsideSession = { schemaVersion: 1, id: "session_outside", taskId: outsideTask.id };
const curatorId = "principal_curator";
const findingKey = "check-stale-projection";
const skillId = "verify-projection";
const tokens = {
  worker: "fixture-worker-credential-for-skill-curation",
  curator: "fixture-curator-credential-for-skill-curation",
  reviewer: "fixture-reviewer-credential-for-skill-curation",
};
const hash = (value) => createHash("sha256").update(value).digest("hex");

function grant(principalId, token, taskIds, sessions, extra = {}) {
  return { principalId, tokenDigest: hash(token), taskIds, sessions, actionKinds: [], ...extra };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "praxis-knowledge-test-"));
  const database = join(root, "state.sqlite");
  const skills = { directory: join(root, "curated"), curatorPrincipalId: curatorId };
  const registries = [];
  const stores = [];
  const servers = [];
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all(servers.map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }));
    for (const service of registries) service.close();
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true });
  });
  const workerSessions = [firstSession, secondSession, outsideSession].map(({ id }) => ({
    sessionId: id, canReport: true,
    ...(id === firstSession.id && { curatedSkills: [{ skillId, version: 1 }] }),
  }));
  const grants = [
    grant("principal_worker", tokens.worker, [firstTask.id, secondTask.id, outsideTask.id], workerSessions),
    grant(curatorId, tokens.curator, [firstTask.id, secondTask.id], []),
    grant("principal_reviewer", tokens.reviewer, [firstTask.id], [], { canReviewSkills: true }),
  ];
  const configuration = mcp.mcpAuthoritySchema.parse({ schemaVersion: 1, database, skills, grants });
  const validated = [];
  const start = async (enabled = true) => {
    const store = new OperationalStore(database);
    stores.push(store);
    for (const task of [firstTask, secondTask, outsideTask]) store.recordTask(task);
    for (const session of [firstSession, secondSession, outsideSession]) store.recordSession(session);
    const service = enabled ? new mcp.CuratedSkills({
      directory: configuration.skills.directory,
      validate: (published) => { validated.push(published); },
    }) : undefined;
    if (service) registries.push(service);
    const server = mcp.createPraxisMcpServer({
      store, grants: configuration.grants,
      ...(service && { skills: { service, curatorPrincipalId: configuration.skills.curatorPrincipalId } }),
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
      store, service,
      async connect(role) {
        const client = new Client({ name: "knowledge-workflow-fixture", version: "1" });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:"
          + server.address().port + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + tokens[role] } } }));
        return client;
      },
    };
  };
  return { start, validated };
}

function finding(session = firstSession, id = "first", overrides = {}) {
  return {
    sessionId: session.id,
    submissionId: "event_knowledge_" + id,
    findingKey,
    observation: "A completed operation can still display the previous state.",
    evidence: "The " + id + " scoped integration fixture reproduced the stale result after restart.",
    ...overrides,
  };
}

const draft = {
  skillId,
  description: "Verify that a persisted change is visible from a new process.",
  body: "# Verify a persisted projection\n\nReopen the application and verify the recorded result against the visible projection.",
  owner: "Engineering workflow maintainer",
  lifecycle: "Review after a relevant storage or projection change.",
  verification: "A replay fixture passes only after the persisted state is reread.",
};

function create(revision, overrides = {}) {
  return {
    findingKey, revision, decision: "create", sourceInspected: "Existing operational tests and skill catalog",
    rationale: "The persisted projection has no reusable verification procedure.", draft, ...overrides,
  };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { error: Boolean(result.isError), ...result.structuredContent };
}

const names = async (client) => (await client.listTools()).tools.map(({ name }) => name);

test("scoped worker findings survive concurrent retries, are grouped, and stay separate from the curator's authority", async (t) => {
  const { start } = await fixture(t);
  const [first, second] = await Promise.all([start(), start()]);
  const [worker, parallel, curator, reviewer] = await Promise.all([
    first.connect("worker"), second.connect("worker"), first.connect("curator"), second.connect("reviewer"),
  ]);
  assert.ok((await names(worker)).includes("propose_skill"));
  assert.ok(!(await names(worker)).includes("decide_skill_proposal"));
  assert.ok(!(await names(reviewer)).includes("request_skill_review"));
  const submissions = await Promise.all([
    call(worker, "propose_skill", finding()),
    call(parallel, "propose_skill", finding()),
    call(parallel, "propose_skill", finding(secondSession, "second")),
  ]);
  assert.deepEqual(submissions.map(({ write }) => write).sort(), ["duplicate", "inserted", "inserted"]);
  assert.equal((await call(worker, "propose_skill", finding(firstSession, "first", {
    observation: "Different evidence under the same submission identity.",
  }))).code, "identity_conflict");
  assert.equal((await call(worker, "propose_skill", finding(outsideSession, "outside"))).code, "forbidden");
  assert.ok((await call(worker, "decide_skill_proposal", create(2))).error);
  const curatorView = await call(curator, "inspect_skill_proposals", { findingKey });
  assert.equal(curatorView.group.findings.length, 2);
  assert.equal(curatorView.group.revision, 2);
  const reviewerView = await call(reviewer, "inspect_skill_proposals", { findingKey });
  assert.deepEqual(reviewerView.group.findings.map(({ taskId }) => taskId), [firstTask.id]);
  const disabled = await start(false);
  assert.ok(!(await names(await disabled.connect("worker"))).includes("propose_skill"));
});

test("the curator checks stale reviews and publishes immutable versions for selected workers", async (t) => {
  const { start, validated } = await fixture(t);
  const first = await start();
  const [worker, curator] = await Promise.all([first.connect("worker"), first.connect("curator")]);
  await call(worker, "propose_skill", finding());
  await call(worker, "propose_skill", finding(secondSession, "second"));
  assert.equal((await call(curator, "decide_skill_proposal", create(1))).code, "stale_review");
  const rejectedDraft = { ...draft, body: draft.body + "\nLocal output is at C:\\Users\\Private\\session.jsonl." };
  assert.equal((await call(curator, "decide_skill_proposal", create(2, { draft: rejectedDraft }))).code, "invalid_skill");

  const [left, right] = await Promise.all([
    call(curator, "request_skill_review", { findingKey, revision: 2, taskId: firstTask.id }),
    call(curator, "request_skill_review", { findingKey, revision: 2, taskId: firstTask.id }),
  ]);
  assert.equal(left.workId, right.workId);
  assert.deepEqual([left.write, right.write].sort(), ["duplicate", "inserted"]);
  assert.equal(first.store.management.list().filter(({ work }) => work.id === left.workId).length, 1);
  const created = await call(curator, "decide_skill_proposal", create(2));
  assert.equal(created.decision, "create");
  assert.deepEqual(created.skill, { skillId, version: 1 });
  assert.equal((await call(curator, "decide_skill_proposal", create(2))).write, "duplicate");

  await call(worker, "propose_skill", finding(secondSession, "reopened"));
  const restarted = await start();
  const manager = await restarted.connect("curator");
  const base = { findingKey, revision: 3, sourceInspected: "Existing curated skill", rationale: "Keep one owner." };
  const updated = await call(manager, "decide_skill_proposal", {
    ...base, decision: "update", previousVersion: 1, draft: { ...draft, body: draft.body + "\nCheck from a new process." },
  });
  assert.deepEqual(updated.skill, { skillId, version: 2 });
  const selected = await call(worker, "load_curated_skill", { sessionId: firstSession.id, skillId, version: 1 });
  assert.ok(selected.skill.markdown.includes(draft.body));
  assert.equal(selected.skill.digest, hash(selected.skill.markdown));
  assert.ok(!JSON.stringify(selected).includes("scoped integration fixture"));
  assert.equal((await call(worker, "load_curated_skill", { sessionId: firstSession.id, skillId, version: 2 })).code, "forbidden");
  assert.equal(validated[0].skillId, skillId);

  await call(worker, "propose_skill", finding(firstSession, "again"));
  const reused = await call(manager, "decide_skill_proposal", {
    ...base, revision: 4, decision: "reuse", reference: { skillId, version: 2 },
  });
  assert.equal(reused.decision, "reuse");
  await call(worker, "propose_skill", finding(firstSession, "unconfirmed"));
  const rejected = await call(manager, "decide_skill_proposal", {
    ...base, revision: 5, decision: "reject", rationale: "The additional observation does not justify another change.",
  });
  assert.equal(rejected.decision, "reject");
  const final = await call(manager, "inspect_skill_proposals", { findingKey });
  assert.deepEqual(final.group.decisions.map(({ decision }) => decision), ["reject", "reuse", "update", "create"]);
});
