import { Component, computed, input, output } from "@angular/core";
import { ButtonAtom } from "../../../ui/button/button-atom.component";
import type { ManagerResource } from "../../../native/desktop-bridge.service";

@Component({
  selector: "praxis-manager-card",
  imports: [ButtonAtom],
  templateUrl: "./manager-card-molecule.component.html",
  styleUrl: "./manager-card-molecule.component.css",
})
export class ManagerCardMolecule {
  readonly resource = input.required<ManagerResource>();
  readonly dismissed = output<void>();
  protected readonly title = computed(() => {
    const resource = this.resource();
    if (resource.kind === "task") return resource.task.title;
    if (resource.kind === "session") return "Worker session";
    return resource.resource === "task" ? "Task unavailable" : "Worker session unavailable";
  });
  protected readonly status = computed(() => {
    const resource = this.resource();
    return resource.kind === "session" ? (resource.status?.replaceAll("_", " ") ?? "Unavailable") : "";
  });
}
