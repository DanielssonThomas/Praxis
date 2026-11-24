export function populateReports(store, latestDay = "2026-08-20") {
  const earlierDay = new Date(Date.parse(latestDay) - 12 * 86_400_000).toISOString().slice(0, 10);
  const version = { schemaVersion: 1 };
  const task = { kind: "task", id: "task_report" };
  store.recordTask({ ...version, id: task.id, title: "Report fixture" });
  store.recordSession({ ...version, id: "session_report", taskId: task.id });
  store.recordUsage({ ...version, id: "usage_report", sessionId: "session_report", metering: "reported",
    inputTokens: 12, outputTokens: 8, cost: { amount: 0, currency: "USD" } });
  store.recordUsage({ ...version, id: "usage_unknown", sessionId: "session_report", metering: "unknown",
    reason: "Runtime did not report usage" });
  const event = (id, kind, day, time, subject, details) => store.appendEvent({
    ...version, id: `event_${id}`, kind, occurredAt: `${day}T${time}:00Z`, subject,
    ...(details === undefined ? {} : { details }),
  });
  const provider = (number) => ({
    type: "provider_delivery", reference: { provider: "github", repository: "example/praxis", number },
  });
  const action = { kind: "action", id: "action_intervention" };
  const decision = {
    type: "action_lifecycle", actionId: action.id, requestId: "event_request",
    transition: { stage: "decision", value: {
      kind: "approve", scopeDigest: "a".repeat(64), approvalId: "approval_intervention",
    } },
  };
  event("merged_duplicate", "provider.pr_merged", latestDay, "10:09", task, provider(81));
  event("opened", "provider.pr_opened", earlierDay, "10:00", task, provider(81));
  event("started", "task.started", earlierDay, "10:00", task);
  event("merged", "provider.pr_merged", latestDay, "10:00", task, provider(81));
  event("opened_recent", "provider.pr_opened", latestDay, "10:05", task, provider(82));
  event("completed", "task.completed", latestDay, "10:00", task);
  event("completed_duplicate", "task.completed", latestDay, "10:30", task);
  event("ticket", "provider.ticket_completed", latestDay, "10:00", task, provider(34));
  event("known_usage", "usage.observed", latestDay, "10:04", { kind: "usage", id: "usage_report" });
  event("known_usage_duplicate", "usage.observed", latestDay, "10:07", { kind: "usage", id: "usage_report" });
  event("unknown_usage", "usage.observed", earlierDay, "10:05", { kind: "usage", id: "usage_unknown" });
  event("decision", "action.decision", latestDay, "10:05", action, decision);
  event("decision_duplicate", "action.decision", latestDay, "10:09", action, decision);
  event("routine", "action.decision", latestDay, "10:10", { kind: "action", id: "action_routine" }, {
    ...decision, actionId: "action_routine", requestId: "event_routine",
    transition: { stage: "decision", value: { kind: "routine", scopeDigest: "a".repeat(64) } },
  });
  return { earlierDay, latestDay };
}
