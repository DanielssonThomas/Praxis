import { providerDeliveryEventKindSchema } from "@praxis/contracts";
import type { ReportDays, ReportMetric, ReportPreferences } from "@praxis/settings";
import type { OperationalStore } from "@praxis/state";

const providerMetrics = {
  "provider.pr_opened": "prsOpened",
  "provider.pr_merged": "prsMerged",
  "provider.ticket_completed": "ticketsCompleted",
} as const;
const kinds = [
  ...providerDeliveryEventKindSchema.options,
  "task.started", "task.completed", "usage.observed", "action.decision",
];
const dayMs = 86_400_000;

export interface ReportBucket {
  day: string;
  metrics: Record<ReportMetric, number | null>;
}
export interface ReportProjection {
  days: ReportDays;
  buckets: ReportBucket[];
}
export interface ReportResult extends ReportProjection {
  preferences: ReportPreferences;
}

export function projectReports(
  store: OperationalStore, preferences: ReportPreferences, requestedDays: ReportDays, now: Date,
): ReportProjection {
  const days = Math.min(requestedDays, preferences.retentionDays) as ReportDays;
  if (!preferences.collectionEnabled) return { days, buckets: [] };

  const end = now.getTime();
  const today = Math.floor(end / dayMs);
  const cleared = preferences.clearedBefore === undefined ? -Infinity : Date.parse(preferences.clearedBefore);
  const retainedFrom = Math.max((today - preferences.retentionDays + 1) * dayMs, cleared + 1);
  const visibleDay = Math.max(today - days + 1, Math.floor(retainedFrom / dayMs));
  const buckets = new Map<number, ReportBucket>();
  for (let day = visibleDay; day <= today; day++) {
    buckets.set(day, {
      day: new Date(day * dayMs).toISOString().slice(0, 10),
      metrics: {
        prsOpened: null, prsMerged: null, ticketsCompleted: null,
        taskMinutes: null, tokens: null, costUsd: null, interventions: 0,
      },
    });
  }

  const events = kinds.flatMap((kind) => store.eventsOfKind(kind))
    .map((event) => ({ event, time: Date.parse(event.occurredAt) }))
    .filter(({ time }) => time <= end)
    .sort((a, b) => a.time - b.time);
  const providerSeen = new Set<string>();
  const providerAvailable = new Set<typeof providerMetrics[keyof typeof providerMetrics]>();
  const started = new Map<string, number>();
  const completed = new Set<string>();
  const durationSamples = new Map<ReportBucket, number>();
  const observed = new Set<string>();
  const interventionSeen = new Set<string>();

  for (const { event: { kind, subject, details }, time } of events) {
    const bucket = time >= retainedFrom ? buckets.get(Math.floor(time / dayMs)) : undefined;
    const delivery = providerDeliveryEventKindSchema.safeParse(kind);
    if (delivery.success && details?.type === "provider_delivery") {
      const { provider, repository, number } = details.reference;
      const identity = JSON.stringify([delivery.data, provider, repository, number]);
      if (providerSeen.has(identity)) continue;
      providerSeen.add(identity);
      const metric = providerMetrics[delivery.data];
      if (time >= retainedFrom) providerAvailable.add(metric);
      if (bucket) bucket.metrics[metric] = (bucket.metrics[metric] ?? 0) + 1;
    } else if (subject.kind === "task" && kind === "task.started") {
      if (time > cleared && !started.has(subject.id)) started.set(subject.id, time);
    } else if (subject.kind === "task" && kind === "task.completed") {
      const start = started.get(subject.id);
      if (start === undefined || completed.has(subject.id)) continue;
      completed.add(subject.id);
      if (bucket) {
        durationSamples.set(bucket, (durationSamples.get(bucket) ?? 0) + 1);
        bucket.metrics.taskMinutes = (bucket.metrics.taskMinutes ?? 0) + (time - start) / 60_000;
      }
    } else if (kind === "usage.observed" && subject.kind === "usage") {
      if (observed.has(subject.id)) continue;
      observed.add(subject.id);
      if (!bucket) continue;
      const usage = store.getUsage(subject.id);
      if (usage?.metering !== "reported") continue;
      if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        bucket.metrics.tokens = (bucket.metrics.tokens ?? 0) + usage.inputTokens + usage.outputTokens;
      }
      if (usage.cost?.currency === "USD") {
        bucket.metrics.costUsd = (bucket.metrics.costUsd ?? 0) + usage.cost.amount;
      }
    } else if (kind === "action.decision" && details?.type === "action_lifecycle"
      && details.transition.stage === "decision"
      && (details.transition.value.kind === "approve" || details.transition.value.kind === "deny")) {
      if (interventionSeen.has(details.requestId)) continue;
      interventionSeen.add(details.requestId);
      if (bucket) bucket.metrics.interventions = (bucket.metrics.interventions ?? 0) + 1;
    }
  }

  for (const bucket of buckets.values()) {
    for (const metric of providerAvailable) bucket.metrics[metric] ??= 0;
    if (bucket.metrics.taskMinutes !== null) {
      bucket.metrics.taskMinutes /= durationSamples.get(bucket)!;
    }
  }
  return { days, buckets: [...buckets.values()] };
}
