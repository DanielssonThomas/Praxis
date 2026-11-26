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
  "task.delegate": "Delegate task to Codex",
};

export function activityActionLabel(kind: string): string {
  return actionNames[kind] ?? kind;
}

export function activityDetail({ action, phase }: ActivityCard): string {
  if (phase.state === "resolved") {
    const status = phase.native.status.replaceAll("_", " ");
    if (action.kind === "task.delegate") return `Codex reported the run as ${status}.`;
    return phase.native.status === "stopping"
      ? "Stop requested. Hermes has yet to report a settled stop."
      : `Hermes reported the run as ${status}.`;
  }
  return "reason" in phase ? phase.reason : "";
}
