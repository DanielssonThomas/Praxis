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

const taskReference = z.strictObject({ kind: z.literal("task"), id: taskIdSchema });
const sessionReference = z.strictObject({ kind: z.literal("session"), id: sessionIdSchema });
const actionReference = z.strictObject({ kind: z.literal("action"), id: actionIdSchema });
const approvalReference = z.strictObject({ kind: z.literal("approval"), id: approvalIdSchema });
const usageReference = z.strictObject({ kind: z.literal("usage"), id: usageIdSchema });

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
});
export type Event = z.infer<typeof eventSchema>;

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
