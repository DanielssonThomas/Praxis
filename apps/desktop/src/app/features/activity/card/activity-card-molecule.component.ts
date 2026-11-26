import { Component, computed, input, output } from "@angular/core";
import type { ActivityCard, DecideActivityRequest, OperatorDecision } from "../../../native/desktop-bridge.service";
import { ButtonAtom } from "../../../ui/button/button-atom.component";

const labels = {
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

const names: Record<string, string> = {
  "session.stop": "Stop worker",
  "session.inspect": "Inspect worker",
  "management.review": "Review background management",
};

@Component({
  selector: "praxis-activity-card",
  imports: [ButtonAtom],
  templateUrl: "./activity-card-molecule.component.html",
  styleUrl: "./activity-card-molecule.component.css",
})
export class ActivityCardMolecule {
  readonly card = input.required<ActivityCard>();
  readonly busy = input.required<boolean>();
  readonly inspectRequested = output<string>();
  readonly decisionRequested = output<DecideActivityRequest>();
  protected readonly label = computed(() => labels[this.card().phase.state]);
  protected readonly title = computed(() => {
    const { action } = this.card();
    return `${names[action.kind] ?? action.kind} · ${action.target.id}`;
  });
  protected readonly detail = computed(() => {
    const phase = this.card().phase;
    if (phase.state === "attention") return `Approval expires ${new Date(phase.expiresAt).toLocaleTimeString()}.`;
    if (phase.state === "resolved") return phase.native.status === "stopping"
      ? "Stop requested. Hermes has yet to report a settled stop."
      : `Hermes reported the run as ${phase.native.status.replaceAll("_", " ")}.`;
    return "reason" in phase ? phase.reason : "";
  });

  protected decide(decision: OperatorDecision): void {
    const { requestId, phase } = this.card();
    if (phase.state === "attention") {
      this.decisionRequested.emit({ requestId, approvalId: phase.approval.id, decision });
    }
  }
}
