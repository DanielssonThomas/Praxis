import { Component, computed, input, output } from "@angular/core";
import { ButtonAtom } from "../../../ui/button/button-atom.component";
import type { ManagerCard } from "../manager-view.model";

@Component({
  selector: "praxis-manager-card",
  imports: [ButtonAtom],
  templateUrl: "./manager-card-molecule.component.html",
  styleUrl: "./manager-card-molecule.component.css",
})
export class ManagerCardMolecule {
  readonly card = input.required<ManagerCard>();
  readonly titleId = input.required<string>();
  readonly closed = output<void>();
  readonly dismissed = output<void>();
  protected readonly status = computed(() => {
    const resource = this.card().value;
    return resource.kind === "session" ? (resource.status?.replaceAll("_", " ") ?? "Unavailable") : "";
  });
}
