import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as management from "@praxis/management";
import { OperationalStore } from "@praxis/state";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const task = { schemaVersion: 1, id: "task_policy", title: "Scoped policy fixture" };
const session = { schemaVersion: 1, id: "session_policy", taskId: task.id };
const manager = "principal_policy_manager";
const operator = "principal_policy_operator";
const policy = { version: "1", digest: digest("core"), profiles: [] };
const host = { agent: "praxis", version: "1", model: "fixture", os: "linux-x64", surface: "cli" };
const brief = {
  id: task.id, objective: "Update the scoped fixture", ownedPaths: ["src"], policy,
  criteria: [{ id: "tests", description: "The mandatory checks pass", required: true }],
  requiredCapabilities: ["process-execution"], limits: { timeoutMs: 30_000, maxAttempts: 1, maxConcurrency: 1 },
};
const requirements = [{ id: "check", criterionId: "tests", kind: "automated", command: { script: { name: "test" } } }];
const assignment = { schemaVersion: 1, taskId: task.id, sessionId: session.id, runId: "worker_scoped", runtime: "codex" };
const observation = {
  snapshot: { schemaVersion: 1, taskId: task.id, sessionId: session.id, status: "completed", output: {
    availability: "available", text: "Verified fixture result", truncated: false,
  } },
  usage: { schemaVersion: 1, id: "usage_policy", sessionId: session.id, metering: "unknown", reason: "Unit fixture" },
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "praxis-effective-policy-"));
  const root = join(directory, "source");
  await mkdir(root);
  const store = new OperationalStore(join(directory, "store.sqlite"));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  store.recordTask(task);
  store.recordSession(session);
  const input = {
    grants: [{ principalId: manager, tokenDigest: "a".repeat(64), taskIds: [task.id], sessions: [], actionKinds: ["task.delegate"] }],
    authority: { revision: 1, root, brief, requirements, protectedPaths: ["checks"], verificationHost: host, reviewerId: operator },
    sourceDigest: digest("integrated"), outsideScopeDigest: digest("outside"), outcome: "passed",
  };
  function intent(suffix, actorId = manager) {
    const id = `event_request_${suffix}`;
    const target = { kind: "task", id: task.id };
    store.appendEvent({ schemaVersion: 1, id, subject: target, occurredAt: new Date().toISOString(), kind: "action.requested", details: {
      type: "action_request", actorId, action: { schemaVersion: 1, id: `action_request_${suffix}`, kind: "task.delegate", target },
    } });
    return id;
  }
  const axiom = {
    parseBrief: structuredClone,
    parseHost: structuredClone,
    policy: () => policy,
    snapshot: async ({ excludedPaths }) => ({ digest: excludedPaths ? input.outsideScopeDigest : input.sourceDigest }),
    plan: async ({ root, task, requirements }) => ({ root, task, requirements, checks: [{
      id: "check", criterionId: "tests", kind: "automated", required: true, timeoutMs: 30_000,
      invocation: { executable: "npm", args: ["run", "test"], cwd: root }, sources: [{ path: "package.json", digest: digest("manifest") }],
    }] }),
    verify: async (plan, host) => ({ id: "trusted-run", plan, host, report: { conforms: true, checks: [{
      id: "check", criterionId: "tests", kind: "automated", required: true, evidenceId: "trusted-run.check", outcome: { status: "passed" },
    }] } }),
    assess: async () => ({ conforms: input.outcome === "passed", checks: [{
      id: "check", criterionId: "tests", kind: "automated", required: true, evidenceId: "trusted-run.check",
      outcome: input.outcome === "passed" ? { status: "passed" } : { status: input.outcome, reason: "Fixture observation" },
    }] }),
    evidenceStartedAt: async () => new Date().toISOString(),
  };
  assert.equal(typeof management.EffectivePolicyService, "function", "The host needs a scoped task admission and completion service");
  const service = new management.EffectivePolicyService({
    store, loadGrants: async () => input.grants, loadAuthority: async () => input.authority,
  }, axiom);
  return { service, input, store, intent };
}

test("admission binds an authenticated delegation intent to the exact canonical task and brief once", async (t) => {
  const { service, intent, store } = await fixture(t);
  const requestId = intent("canonical");
  const attempts = await Promise.all([service.admit(requestId, session.id), service.admit(requestId, session.id)]);
  const [first, second] = attempts;
  assert.deepEqual(attempts.map(({ write }) => write).sort(), ["duplicate", "inserted"]);
  assert.equal(first.admissionId, second.admissionId);
  assert.deepEqual(first.request, { task, session, brief });
  assert.equal(store.eventsOfKind("task.delegation_admitted").length, 1);
  await assert.rejects(service.admit(intent("worker", "principal_ungranted_worker"), session.id), { code: "forbidden" });
});

test("the original authority version protects mandatory checks and external requirements", async (t) => {
  const { service, input, intent, store } = await fixture(t);
  const { admissionId } = await service.admit(intent("original"), session.id);
  input.authority = { ...input.authority, brief: { ...brief, criteria: [{ ...brief.criteria[0], required: false }] } };
  await assert.rejects(service.admit(intent("unversioned"), session.id), { code: "authority_conflict" });
  input.authority = { ...input.authority, revision: 2, brief: { ...brief, ownedPaths: ["checks"] } };
  await assert.rejects(service.admit(intent("grader"), session.id), { code: "forbidden" });
  input.authority = { ...input.authority, brief: { ...brief, ownedPaths: ["package.json"] } };
  await assert.rejects(service.admit(intent("manifest"), session.id), { code: "forbidden" });
  input.authority = { ...input.authority, brief };
  await service.admit(intent("new_version"), session.id);
  await assert.rejects(service.verify(admissionId), { code: "stale" });
  assert.equal(store.eventsOfKind("task.delegation_admitted").length, 2);
});

test("completion requires the same reviewed source, the settled result, and fresh passing mandatory evidence", async (t) => {
  const { service, input, intent, store } = await fixture(t);
  const { admissionId } = await service.admit(intent("completed"), session.id);
  await assert.rejects(service.inspectIntegration({ admissionId, assignment, observation }), { code: "invalid_input" });
  assert.equal(await service.recordLaunch(admissionId, assignment), "inserted");
  assert.equal(await service.recordLaunch(admissionId, assignment), "duplicate");
  await assert.rejects(service.recordLaunch(admissionId, { ...assignment, runId: "worker_other" }), { code: "authority_conflict" });
  const verification = await service.verify(admissionId);
  const reviewed = await service.inspectIntegration({ admissionId, assignment, observation });
  const request = { admissionId, assignment, observation, review: {
    reviewerId: operator, sourceDigest: reviewed.source.digest, receiptDigest: reviewed.receiptDigest,
  }, verification };
  await assert.rejects(service.complete({ ...request, review: { ...request.review, reviewerId: manager } }), { code: "forbidden" });
  await assert.rejects(service.complete({ ...request, assignment: { ...assignment, sessionId: "session_foreign" } }), { code: "invalid_input" });
  await assert.rejects(service.complete({ ...request, observation: { ...observation, snapshot: { ...observation.snapshot, status: "running" } } }), { code: "invalid_input" });
  await assert.rejects(service.complete({ ...request, observation: { ...observation, snapshot: { ...observation.snapshot,
    output: { ...observation.snapshot.output, text: "A different result" },
  } } }), { code: "stale" });
  for (const outcome of ["failed", "blocked", "not_run", "not_applicable"]) {
    input.outcome = outcome;
    assert.equal((await service.complete(request)).verification.checks[0].outcome.status, outcome);
  }
  input.outcome = "passed";
  input.sourceDigest = digest("later integrated edit");
  await assert.rejects(service.complete(request), { code: "stale" });
  input.sourceDigest = request.review.sourceDigest;
  input.outsideScopeDigest = digest("changed mandatory check");
  await assert.rejects(service.complete(request), { code: "stale" });
  input.outsideScopeDigest = digest("outside");
  input.grants = [{ ...input.grants[0], taskIds: [] }];
  await assert.rejects(service.complete(request), { code: "forbidden" });
  input.grants = [{ ...input.grants[0], taskIds: [task.id] }];
  assert.equal(store.eventsOfKind("task.completed").length, 0);
  assert.equal((await service.complete(request)).write, "inserted");
  assert.equal((await service.complete(request)).write, "duplicate");
  const [completed] = store.eventsOfKind("task.completed");
  assert.equal(completed.details.reviewerId, operator);
  assert.equal(completed.details.sourceDigest, reviewed.source.digest);
  assert.equal(completed.details.runId, assignment.runId);
});
