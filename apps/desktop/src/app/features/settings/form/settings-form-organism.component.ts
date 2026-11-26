import { Component, input, output } from "@angular/core";
import type { PortableSettings, WorkerRuntime } from "../../../../generated/desktop-ipc";
import { ButtonAtom } from "../../../ui/button/button-atom.component";

@Component({
  selector: "praxis-settings-form",
  imports: [ButtonAtom],
  templateUrl: "./settings-form-organism.component.html",
  styleUrl: "./settings-form-organism.component.css",
})
export class SettingsFormOrganism {
  readonly settings = input.required<PortableSettings>();
  readonly busy = input(false);
  readonly submitted = output<PortableSettings>();

  protected submit(event: SubmitEvent): void {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement) || this.busy()) return;
    const fields = new FormData(form);
    const read = (name: string) => String(fields.get(name) ?? "").trim();
    const numberOrNull = (name: string) => read(name) === "" ? null : Number(read(name));
    this.submitted.emit({
      ...this.settings(),
      policy: {
        axiomEnabled: fields.has("axiomEnabled"),
        profiles: read("profiles").split(",").map((profile) => profile.trim()).filter(Boolean),
      },
      manager: {
        runtime: "hermes",
        profile: read("managerProfile"),
        model: read("managerModel") || null,
      },
      worker: {
        runtime: read("workerRuntime") as WorkerRuntime,
        model: read("workerModel") || null,
      },
      budgets: { maxTaskTokens: numberOrNull("maxTaskTokens"), maxTaskUsd: numberOrNull("maxTaskUsd") },
      memory: { enabled: fields.has("memoryEnabled") },
      display: { autoPresent: fields.has("autoPresent") },
    });
  }
}
