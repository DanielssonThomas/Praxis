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
  const workerRoot = join(directory, "worker");
  await Promise.all([mkdir(root), mkdir(workerRoot)]);
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
    sourceDigest: digest("integrated"), workerSourceDigest: digest("integrated"),
    outsideScopeDigest: digest("outside"), outcome: "passed",
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
    snapshot: async ({ root: sourceRoot, excludedPaths }) => ({
      digest: excludedPaths ? input.outsideScopeDigest : sourceRoot === workerRoot ? input.workerSourceDigest : input.sourceDigest,
    }),
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
  const admit = async (requestId, sessionId = session.id) => service.admit(requestId, sessionId, (await service.preview(requestId, sessionId)).fingerprint);
  return { service, input, store, intent, admit, workerRoot };
}

test("admission binds an authenticated delegation intent to the exact canonical task and brief once", async (t) => {
  const { service, intent, store } = await fixture(t);
  const requestId = intent("canonical");
  const preview = await service.preview(requestId, session.id);
  assert.deepEqual(preview.request, { task, session, brief });
  assert.equal(store.eventsOfKind("task.delegation_admitted").length, 0);
  await assert.rejects(service.admit(requestId, session.id, digest("different approval")), { code: "stale" });
  const attempts = await Promise.all(Array.from({ length: 2 }, () => service.admit(requestId, session.id, preview.fingerprint)));
  const [first, second] = attempts;
  assert.deepEqual(attempts.map(({ write }) => write).sort(), ["duplicate", "inserted"]);
  assert.equal(first.admissionId, second.admissionId);
  assert.deepEqual(first.request, { task, session, brief });
  assert.equal(store.eventsOfKind("task.delegation_admitted").length, 1);
  await assert.rejects(service.preview(intent("worker", "principal_ungranted_worker"), session.id), { code: "forbidden" });
});

test("separate delegation requests cannot race past the durable admission limits", async (t) => {
  const { intent, store, admit } = await fixture(t);
  const alternate = { ...session, id: "session_alternate" };
  store.recordSession(alternate);
  const attempts = await Promise.allSettled([
    admit(intent("first")), admit(intent("duplicate_session")), admit(intent("other_session"), alternate.id),
  ]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.deepEqual(attempts.flatMap((attempt) => attempt.status === "rejected" ? [attempt.reason.code] : []).sort(), ["limit", "limit"]);
  assert.equal(store.eventsOfKind("task.delegation_admitted").length, 1);
});

test("the original authority version protects mandatory checks and external requirements", async (t) => {
  const { service, input, intent, store, admit } = await fixture(t);
  const scopedBrief = { ...brief, limits: { ...brief.limits, maxAttempts: 2, maxConcurrency: 2 } };
  const second = { ...session, id: "session_policy_second" };
  store.recordSession(second);
  input.authority = { ...input.authority, brief: scopedBrief };
  const { admissionId } = await admit(intent("original"));
  input.authority = { ...input.authority, brief: { ...scopedBrief, criteria: [{ ...brief.criteria[0], required: false }] } };
  await assert.rejects(admit(intent("unversioned")), { code: "authority_conflict" });
  input.authority = { ...input.authority, revision: 2, brief: { ...brief, ownedPaths: ["checks"] } };
  await assert.rejects(admit(intent("grader")), { code: "forbidden" });
  input.authority = { ...input.authority, brief: { ...brief, ownedPaths: ["package.json"] } };
  await assert.rejects(admit(intent("manifest")), { code: "forbidden" });
  input.authority = { ...input.authority, brief: scopedBrief };
  await admit(intent("new_version"), second.id);
  await assert.rejects(service.verify(admissionId), { code: "stale" });
  assert.equal(store.eventsOfKind("task.delegation_admitted").length, 2);
});

test("completion requires the same reviewed source, the settled result, and fresh passing mandatory evidence", async (t) => {
  const { service, input, intent, store, admit, workerRoot } = await fixture(t);
  const requestId = intent("completed");
  const { admissionId } = await admit(requestId);
  const integration = { admissionId, assignment, observation, workerRoot };
  await assert.rejects(service.inspectIntegration(integration), { code: "invalid_input" });
  await assert.rejects(service.recordLaunch(admissionId, assignment), { code: "invalid_input" });
  input.workerSourceDigest = digest("different base workspace");
  await assert.rejects(service.verifyStaging(admissionId, workerRoot), { code: "stale" });
  input.workerSourceDigest = input.sourceDigest;
  await service.verifyStaging(admissionId, workerRoot);
  assert.equal(await service.recordLaunch(admissionId, assignment), "inserted");
  assert.equal(await service.recordLaunch(admissionId, assignment), "duplicate");
  await assert.rejects(service.recordLaunch(admissionId, { ...assignment, runId: "worker_other" }), { code: "authority_conflict" });
  assert.equal(await service.recordSettlement(admissionId, assignment, observation), "inserted");
  assert.equal(service.readAdmission(requestId).assignment.runId, assignment.runId);
  assert.equal(service.readAdmission(requestId).settlement.status, "completed");
  const verification = await service.verify(admissionId);
  input.workerSourceDigest = digest("different native result");
  await assert.rejects(service.inspectIntegration(integration), { code: "stale" });
  input.workerSourceDigest = input.sourceDigest;
  const reviewed = await service.inspectIntegration(integration);
  const request = { ...integration, review: {
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
