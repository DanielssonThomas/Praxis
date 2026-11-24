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

export const workerReportPhaseSchema = z.enum(["progress", "result", "blocked"]);
export const workerReportMessageSchema = nonblankText.max(8_192);
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
});
export type Event = z.infer<typeof eventSchema>;

export const approvalSchema = z.strictObject({
  ...version,
  id: approvalIdSchema,
  actionId: actionIdSchema,
});
export type Approval = z.infer<typeof approvalSchema>;

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
