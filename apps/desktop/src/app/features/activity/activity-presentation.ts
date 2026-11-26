import type { ActivityCard } from "../../native/desktop-bridge.service";

export const activityLabels = {
  processing: "Processing",
  attention: "Needs attention",
  resolved: "Decision resolved",
  denied: "Denied",
  expired: "Expired",
  invalidated: "Invalidated",
  refused: "Refused",
  uncertain: "Execution unverified",
  escalated: "Needs human review",
};

const actionNames: Record<string, string> = {
  "session.stop": "Stop worker",
  "session.inspect": "Inspect worker",
  "management.review": "Review background management",
};

export function activityActionLabel(kind: string): string {
  return actionNames[kind] ?? kind;
}

export function activityDetail(phase: ActivityCard["phase"]): string {
  if (phase.state === "resolved") return phase.native.status === "stopping"
    ? "Stop requested. Hermes has yet to report a settled stop."
    : `Hermes reported the run as ${phase.native.status.replaceAll("_", " ")}.`;
  return "reason" in phase ? phase.reason : "";
}
