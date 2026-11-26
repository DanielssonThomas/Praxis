import { Component, effect, inject, signal, untracked } from "@angular/core";
import type { PortableSettings } from "../../../generated/desktop-ipc";
import { DesktopBridge } from "../../native/desktop-bridge.service";
import { HostLaunchService } from "../../native/host-launch.service";
import { SettingsFormOrganism } from "./form/settings-form-organism.component";

@Component({
  selector: "praxis-settings",
  imports: [SettingsFormOrganism],
  templateUrl: "./settings-template.component.html",
  styleUrl: "./settings-template.component.css",
})
export class SettingsTemplate {
  private readonly bridge = inject(DesktopBridge);
  private readonly host = inject(HostLaunchService);
  protected readonly settings = signal<PortableSettings | null>(null);
  protected readonly busy = signal(false);
  protected readonly status = signal(this.bridge.available
    ? "Waiting for the local settings."
    : "Open the Praxis desktop app to edit portable settings.");

  constructor() {
    effect(() => {
      if (this.bridge.available && this.host.status() === null) {
        untracked(() => { void this.load(); });
      }
    });
  }

  protected async save(settings: PortableSettings): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.status.set("Saving settings…");
    try {
      const result = await this.bridge.saveSettings(settings);
      if (result.status === "error") {
        this.status.set(result.error.message);
        return;
      }
      this.settings.set(result.data);
      this.status.set("Settings saved.");
    } catch {
      this.status.set("The local settings could not be saved.");
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.status.set("Loading settings…");
    try {
      const result = await this.bridge.readSettings();
      if (result.status === "error") {
        this.status.set(result.error.message);
        return;
      }
      this.settings.set(result.data);
      this.status.set("");
    } catch {
      this.status.set("The local settings could not be read.");
    } finally {
      this.busy.set(false);
    }
  }
}
