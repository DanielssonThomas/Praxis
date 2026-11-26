import { Component, Injector, afterNextRender, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { HostLaunchService } from "../../../native/host-launch.service";
import { ButtonAtom } from "../../../ui/button/button-atom.component";

@Component({
  selector: "praxis-setup-guide",
  imports: [ButtonAtom, RouterLink],
  templateUrl: "./setup-guide-organism.component.html",
  styleUrl: "./setup-guide-organism.component.css",
})
export class SetupGuideOrganism {
  private readonly injector = inject(Injector);
  protected readonly host = inject(HostLaunchService);
  protected readonly step = signal(0);
  protected readonly steps = [
    { label: "Local host", heading: "Check the local Praxis host" },
    { label: "Hermes profile", heading: "Connect a named Hermes profile" },
    { label: "Operator access", heading: "Open Manager with your operator token" },
  ];

  protected selectStep(index: number, heading: HTMLElement): void {
    this.step.set(index);
    afterNextRender({ write: () => heading.focus() }, { injector: this.injector });
  }

  protected async retryHost(status: HTMLElement): Promise<void> {
    if (this.host.retrying()) return;
    await this.host.retry();
    if (!this.host.canRetry()) status.focus();
  }
}
