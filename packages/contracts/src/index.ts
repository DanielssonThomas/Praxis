import { z } from "zod";

export const contractVersion = 1;
const version = { schemaVersion: z.literal(contractVersion) };
const nonblankText = z.string().refine((value) => value.trim().length > 0, "Expected nonblank text");
const recordKind = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

function recordId<const Kind extends string>(kind: Kind) {
  return z.string().regex(new RegExp(`^${kind}_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)).brand<Kind>();
}

export const taskIdSchema = recordId("task");
export const sessionIdSchema = recordId("session");
export const eventIdSchema = recordId("event");
export const actionIdSchema = recordId("action");
export const approvalIdSchema = recordId("approval");
export const usageIdSchema = recordId("usage");
export const principalIdSchema = recordId("principal");

export type TaskId = z.infer<typeof taskIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type ActionId = z.infer<typeof actionIdSchema>;
export type ApprovalId = z.infer<typeof approvalIdSchema>;
export type UsageId = z.infer<typeof usageIdSchema>;

export const taskSchema = z.strictObject({
  ...version,
  id: taskIdSchema,
  title: nonblankText,
});
export type Task = z.infer<typeof taskSchema>;

export const sessionSchema = z.strictObject({
  ...version,
  id: sessionIdSchema,
  taskId: taskIdSchema,
});
export type Session = z.infer<typeof sessionSchema>;

export const runtimeSessionStatusSchema = z.enum([
  "queued", "running", "waiting_for_approval", "stopping", "stopped",
  "completed", "failed", "interrupted", "unknown",
]);
export type RuntimeSessionStatus = z.infer<typeof runtimeSessionStatusSchema>;

export const runtimeOutputLimit = 16_384;
export const runtimeOutputSchema = z.discriminatedUnion("availability", [
  z.strictObject({
    availability: z.literal("available"),
    text: z.string().max(runtimeOutputLimit),
    truncated: z.boolean(),
  }),
  z.strictObject({ availability: z.literal("unavailable"), reason: nonblankText }),
]);
export type RuntimeOutput = z.infer<typeof runtimeOutputSchema>;

export const runtimeSessionSnapshotSchema = z.strictObject({
  ...version,
  taskId: taskIdSchema,
  sessionId: sessionIdSchema,
  status: runtimeSessionStatusSchema,
  output: runtimeOutputSchema,
});
export type RuntimeSessionSnapshot = z.infer<typeof runtimeSessionSnapshotSchema>;

const taskReference = z.strictObject({ kind: z.literal("task"), id: taskIdSchema });
const sessionReference = z.strictObject({ kind: z.literal("session"), id: sessionIdSchema });
const actionReference = z.strictObject({ kind: z.literal("action"), id: actionIdSchema });
const approvalReference = z.strictObject({ kind: z.literal("approval"), id: approvalIdSchema });
const usageReference = z.strictObject({ kind: z.literal("usage"), id: usageIdSchema });

export const actionSchema = z.strictObject({
  ...version,
  id: actionIdSchema,
  kind: recordKind,
  target: z.discriminatedUnion("kind", [taskReference, sessionReference]),
});
export type Action = z.infer<typeof actionSchema>;

export const approvalSchema = z.strictObject({
  ...version,
  id: approvalIdSchema,
  actionId: actionIdSchema,
});
export type Approval = z.infer<typeof approvalSchema>;

const scopeDigest = z.string().regex(/^[0-9a-f]{64}$/);
const actionEvaluation = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("routine"), scopeDigest }),
  z.strictObject({
    mode: z.literal("approval"),
    scopeDigest,
    approval: approvalSchema,
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({ mode: z.literal("refused"), reason: nonblankText }),
]);
const actionDecision = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("routine"), scopeDigest }),
  z.strictObject({ kind: z.literal("approve"), scopeDigest, approvalId: approvalIdSchema }),
  z.strictObject({ kind: z.literal("deny"), scopeDigest, approvalId: approvalIdSchema }),
  z.strictObject({ kind: z.enum(["invalidated", "expired"]), scopeDigest, reason: nonblankText }),
]);
const actionSettlement = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("resolved"), native: runtimeSessionSnapshotSchema }),
  z.strictObject({ outcome: z.literal("invalidated"), reason: nonblankText }),
  z.strictObject({ outcome: z.literal("uncertain"), reason: nonblankText }),
]);
const actionLifecycleSchema = z.discriminatedUnion("stage", [
  z.strictObject({ stage: z.literal("evaluation"), value: actionEvaluation }),
  z.strictObject({ stage: z.literal("decision"), value: actionDecision }),
  z.strictObject({ stage: z.literal("settlement"), value: actionSettlement }),
]);
export type ActionLifecycle = z.infer<typeof actionLifecycleSchema>;

export const workerReportPhaseSchema = z.enum(["progress", "result", "blocked"]);
export const workerReportMessageSchema = nonblankText.max(8_192);
const githubWorkReference = z.strictObject({
  provider: z.literal("github"),
  repository: z.string()
    .regex(/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/i)
    .toLowerCase()
    .refine((value) => !value.endsWith("/.") && !value.endsWith("/..")),
  number: z.int().positive(),
});
export const githubIssueReferenceSchema = githubWorkReference;
export type GitHubIssueReference = z.infer<typeof githubIssueReferenceSchema>;

export const providerDeliveryEventKindSchema = z.enum([
  "provider.pr_opened", "provider.pr_merged", "provider.ticket_completed",
]);
const workerReportKind = z.templateLiteral(["worker.", workerReportPhaseSchema]);
const eventDetailsSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("worker_report"),
    actorId: principalIdSchema,
    message: workerReportMessageSchema,
  }),
  z.strictObject({
    type: z.literal("action_request"),
    actorId: principalIdSchema,
    action: actionSchema,
  }),
  z.strictObject({
    type: z.literal("action_lifecycle"),
    requestId: eventIdSchema,
    actionId: actionIdSchema,
    transition: actionLifecycleSchema,
  }),
  z.strictObject({ type: z.literal("issue_link"), issue: githubIssueReferenceSchema }),
  z.strictObject({ type: z.literal("provider_delivery"), reference: githubWorkReference }),
]);

export const eventSchema = z.strictObject({
  ...version,
  id: eventIdSchema,
  kind: recordKind,
  occurredAt: z.iso.datetime(),
  subject: z.discriminatedUnion("kind", [
    taskReference,
    sessionReference,
    actionReference,
    approvalReference,
    usageReference,
  ]),
  details: eventDetailsSchema.optional(),
}).superRefine(({ kind, subject, details }, context) => {
  if (details?.type === "worker_report" && (subject.kind !== "session" || !workerReportKind.safeParse(kind).success)) {
    context.addIssue({ code: "custom", path: ["details"], message: "Worker report details require a worker event and a session subject" });
  }
  if (details?.type === "action_request" && (kind !== "action.requested"
    || subject.kind !== details.action.target.kind || subject.id !== details.action.target.id)) {
    context.addIssue({ code: "custom", path: ["details"], message: "Action request details require the exact action target as subject" });
  }
  if (details?.type === "action_lifecycle" && (kind !== `action.${details.transition.stage}`
    || subject.kind !== "action" || subject.id !== details.actionId)) {
    context.addIssue({ code: "custom", path: ["details"], message: "Action lifecycle details require their exact action and stage" });
  }
  if (details?.type === "issue_link" && (kind !== "task.issue_linked" || subject.kind !== "task")) {
    context.addIssue({ code: "custom", path: ["details"], message: "An issue link requires the task subject it links to" });
  }
  if (details?.type === "provider_delivery"
    && (subject.kind !== "task" || !providerDeliveryEventKindSchema.safeParse(kind).success)) {
    context.addIssue({ code: "custom", path: ["details"], message: "Provider delivery details require a delivery event and a task subject" });
  }
});
export type Event = z.infer<typeof eventSchema>;

const usageIdentity = { ...version, id: usageIdSchema, sessionId: sessionIdSchema };

const unknownUsageSchema = z.strictObject({
  ...usageIdentity,
  metering: z.literal("unknown"),
  reason: nonblankText,
});

const reportedUsageSchema = z.strictObject({
  ...usageIdentity,
  metering: z.literal("reported"),
  inputTokens: z.int().nonnegative().optional(),
  outputTokens: z.int().nonnegative().optional(),
  cost: z.strictObject({
    amount: z.number().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).optional(),
}).refine(
  ({ inputTokens, outputTokens, cost }) =>
    inputTokens !== undefined || outputTokens !== undefined || cost !== undefined,
  "Reported usage requires at least one measurement",
);

export const usageSchema = z.discriminatedUnion("metering", [unknownUsageSchema, reportedUsageSchema]);
export type Usage = z.infer<typeof usageSchema>;
