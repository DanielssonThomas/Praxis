import type { ReportMetric } from "../../../generated/desktop-ipc";

export interface ReportMetricDisplay {
  readonly metric: ReportMetric;
  readonly label: string;
  readonly digits: number;
}

export const reportMetrics: readonly ReportMetricDisplay[] = [
  { metric: "prsOpened", label: "PRs opened (recorded)", digits: 0 },
  { metric: "prsMerged", label: "PRs merged (recorded)", digits: 0 },
  { metric: "ticketsCompleted", label: "Tickets completed (recorded)", digits: 0 },
  { metric: "taskMinutes", label: "Average task duration (min)", digits: 1 },
  { metric: "tokens", label: "Reported tokens", digits: 0 },
  { metric: "costUsd", label: "Reported cost (USD)", digits: 4 },
  { metric: "interventions", label: "Operator interventions", digits: 0 },
];

export const reportRanges: readonly number[] = [7, 30, 90];
