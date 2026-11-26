import { Component, computed, input, output } from "@angular/core";
import type { OverviewPane } from "../../../native/desktop-bridge.service";
import { ButtonAtom } from "../../../ui/button/button-atom.component";
import { SessionControlMolecule } from "../control/session-control-molecule.component";

@Component({
  selector: "praxis-overview-worker",
  imports: [ButtonAtom, SessionControlMolecule],
  templateUrl: "./overview-worker-organism.component.html",
  styleUrl: "./overview-worker-organism.component.css",
  host: { "[attr.data-expanded]": "expanded()" },
})
export class OverviewWorkerOrganism {
  readonly pane = input.required<OverviewPane>();
  readonly expanded = input.required<boolean>();
  readonly toggled = output<string>();
  protected readonly state = computed(() => {
    const runtime = this.pane().runtime;
    return runtime.availability === "available" ? runtime.snapshot.status.replaceAll("_", " ") : "Unavailable";
  });
  protected readonly output = computed(() => {
    const runtime = this.pane().runtime;
    if (runtime.availability === "unavailable") return runtime.reason;
    const output = runtime.snapshot.output;
    if (output.availability === "unavailable") return output.reason;
    return (output.truncated ? "Earlier output omitted.\n" : "") + output.text;
  });
  protected readonly usage = computed(() => {
    const runtime = this.pane().runtime;
    if (runtime.availability === "unavailable") return "Usage unavailable";
    const usage = runtime.usage;
    if (usage.metering === "unknown") return usage.reason;
    return [
      usage.inputTokens == null ? "" : `Input tokens ${usage.inputTokens.toLocaleString()}`,
      usage.outputTokens == null ? "" : `Output tokens ${usage.outputTokens.toLocaleString()}`,
      usage.cost == null ? "" : `Cost ${usage.cost.amount} ${usage.cost.currency}`,
    ].filter(Boolean).join(" · ");
  });
}
