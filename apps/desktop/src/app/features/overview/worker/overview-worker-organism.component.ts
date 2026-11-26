import { afterNextRender, Component, computed, inject, Injector, input, output } from "@angular/core";
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

  private readonly injector = inject(Injector);

  protected readonly status = computed(() => {
    const runtime = this.pane().runtime;
    return runtime.availability === "available" ? runtime.snapshot.status : "unavailable";
  });
  protected readonly statusLabel = computed(() => {
    const status = this.status().replaceAll("_", " ");
    return status.charAt(0).toUpperCase() + status.slice(1);
  });
  protected readonly terminal = computed(() => {
    const runtime = this.pane().runtime;
    if (runtime.availability === "unavailable") {
      return { text: runtime.reason, truncated: false, hasOutput: false };
    }
    const output = runtime.snapshot.output;
    if (output.availability === "unavailable") {
      return { text: output.reason, truncated: false, hasOutput: false };
    }
    return {
      text: output.text || "No session output available yet.",
      truncated: output.truncated,
      hasOutput: Boolean(output.text),
    };
  });
  protected readonly usage = computed(() => {
    const runtime = this.pane().runtime;
    return runtime.availability === "available"
      ? runtime.usage
      : { metering: "unknown", reason: "Usage unavailable." } as const;
  });

  protected toggle(event: MouseEvent): void {
    const disclosure = event.currentTarget as HTMLButtonElement;
    this.toggled.emit(this.pane().session.id);
    // Expanding the pane can move the focused disclosure outside the workspace.
    afterNextRender(() => {
      if (disclosure === disclosure.ownerDocument.activeElement) {
        disclosure.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }, { injector: this.injector });
  }
}
