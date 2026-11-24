import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionSchema,
  approvalSchema,
  eventSchema,
  sessionSchema,
  taskSchema,
  usageSchema,
} from "@praxis/contracts";

const task = { schemaVersion: 1, id: "task_Alpha-1", title: "Inspect workspace status" };
const session = { schemaVersion: 1, id: "session_Beta-2", taskId: task.id };
const action = {
  schemaVersion: 1,
  id: "action_Gamma-3",
  kind: "session.stop",
  target: { kind: "session", id: session.id },
};
const approval = { schemaVersion: 1, id: "approval_Delta-4", actionId: action.id };
const usage = {
  schemaVersion: 1,
  id: "usage_Epsilon-5",
  sessionId: session.id,
  metering: "reported",
  inputTokens: 0,
};
const event = {
  schemaVersion: 1,
  id: "event_Zeta-6",
  subject: { kind: "approval", id: approval.id },
  kind: "approval.requested",
  occurredAt: "2026-07-28T10:30:00Z",
};

test("each v1 record round-trips through the workspace public API", () => {
  const records = [
    [taskSchema, task],
    [sessionSchema, session],
    [eventSchema, event],
    [actionSchema, action],
    [approvalSchema, approval],
    [usageSchema, usage],
  ];

  for (const [schema, record] of records) {
    assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(record))), record);
    assert.equal(schema.safeParse({ ...record, schemaVersion: 2 }).success, false, record.id);
    const { schemaVersion, ...unversioned } = record;
    assert.equal(schema.safeParse(unversioned).success, false, record.id);
    assert.equal(schema.safeParse({ ...record, extra: true }).success, false, record.id);
  }
});

test("task and session identities reject native IDs, cross-kind links and blank fields", () => {
  assert.equal(taskSchema.safeParse({ ...task, id: "t_abcd" }).success, false);
  assert.equal(taskSchema.safeParse({ ...task, id: "task_" }).success, false);
  assert.equal(taskSchema.safeParse({ ...task, id: "task_foo/bar" }).success, false);
  assert.equal(taskSchema.safeParse({ ...task, title: "  " }).success, false);
  assert.equal(sessionSchema.safeParse({ ...session, taskId: session.id }).success, false);
});

test("events use a stable ID, a matching typed subject and an absolute timestamp", () => {
  for (const [kind, id] of [
    ["task", task.id],
    ["session", session.id],
    ["action", action.id],
    ["approval", approval.id],
    ["usage", usage.id],
  ]) {
    assert.deepEqual(eventSchema.parse({ ...event, subject: { kind, id } }).subject, { kind, id });
  }
  assert.equal(eventSchema.safeParse({ ...event, id: task.id }).success, false);
  assert.equal(eventSchema.safeParse({ ...event, subject: { kind: "approval", id: action.id } }).success, false);
  assert.equal(eventSchema.safeParse({ ...event, occurredAt: "2026-07-28T10:30:00" }).success, false);
});

test("approval links to one action and action targets use the declared identity kind", () => {
  assert.deepEqual(actionSchema.parse({
    ...action,
    target: { kind: "task", id: task.id },
  }).target, { kind: "task", id: task.id });
  assert.equal(actionSchema.safeParse({ ...action, target: { kind: "task", id: session.id } }).success, false);
  assert.equal(approvalSchema.safeParse({ ...approval, actionId: task.id }).success, false);
  assert.equal(approvalSchema.safeParse({ ...approval, actionId: [action.id] }).success, false);
});

test("usage distinguishes unavailability, measured zero and invalid measurements", () => {
  const { inputTokens, ...identity } = usage;
  const unavailable = { ...identity, metering: "unknown", reason: "Host did not expose metering" };
  const costOnly = { ...identity, cost: { amount: 0, currency: "USD" } };

  assert.deepEqual(usageSchema.parse(unavailable), unavailable);
  assert.deepEqual(usageSchema.parse(costOnly), costOnly);
  assert.equal(usageSchema.parse(usage).inputTokens, 0);
  assert.equal(usageSchema.safeParse(identity).success, false);
  assert.equal(usageSchema.safeParse({ ...unavailable, reason: " " }).success, false);
  assert.equal(usageSchema.safeParse({ ...unavailable, inputTokens: 0 }).success, false);
  assert.equal(usageSchema.safeParse({ ...usage, inputTokens: -1 }).success, false);
  assert.equal(usageSchema.safeParse({ ...usage, outputTokens: 1.5 }).success, false);
  assert.equal(usageSchema.safeParse({ ...usage, sessionId: task.id }).success, false);
});
