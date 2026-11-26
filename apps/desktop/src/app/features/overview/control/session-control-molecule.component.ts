import { Component, computed, inject, input, signal } from "@angular/core";
import type { SessionControl, SessionControlRequest } from "../../../native/desktop-bridge.service";
import { ButtonAtom } from "../../../ui/button/button-atom.component";
import { OverviewService } from "../overview.service";

@Component({
  selector: "praxis-session-control",
  imports: [ButtonAtom],
  templateUrl: "./session-control-molecule.component.html",
  styleUrl: "./session-control-molecule.component.css",
})
export class SessionControlMolecule {
  readonly sessionId = input.required<string>();
  readonly control = input.required<SessionControl>();
  private readonly overview = inject(OverviewService);
  protected readonly busy = signal(false);
  protected readonly feedback = signal("");
  protected readonly mode = computed(() => {
    const { mode, guidance } = this.control();
    if (mode === "manual" && guidance === "pending") return "Manual control. Waiting for Hermes to record guidance.";
    if (mode === "manual" && guidance === "uncertain") return "Manual control. Native guidance delivery is uncertain.";
    if (mode === "manual") return "Manual control";
    return mode === "automated_write" ? "A scoped action holds session control." : "Read-only inspection";
  });

  protected take(): Promise<boolean> {
    return this.operate({ operation: "takeover", sessionId: this.sessionId() });
  }

  protected handBack(): Promise<boolean> {
    return this.operate({ operation: "return", sessionId: this.sessionId() });
  }

  protected async send(event: SubmitEvent, field: HTMLTextAreaElement): Promise<void> {
    event.preventDefault();
    const text = field.value.trim();
    if (text && await this.operate({ operation: "guide", sessionId: this.sessionId(), text })) field.value = "";
  }

  private async operate(request: SessionControlRequest): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    try {
      const result = await this.overview.operate(request);
      if (result.status === "error") {
        this.feedback.set(result.error?.code ? result.error.message : "The session control request failed.");
        return false;
      }
      if (request.operation === "guide") this.feedback.set("Hermes accepted this guidance for delivery.");
      else if (request.operation === "return") {
        this.feedback.set(result.data.guidance === "delivered"
          ? "Control returned. Hermes delivered the guidance at a tool boundary."
          : result.data.guidance === "recorded"
            ? "Control returned. Hermes recorded the guidance in the transcript." : "Control returned.");
      } else this.feedback.set("");
      return true;
    } catch {
      this.feedback.set("The session control request failed.");
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
