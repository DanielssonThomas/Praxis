import { Component, input, output } from "@angular/core";
import type { KanbanTask } from "../../../generated/desktop-ipc";
import { ButtonAtom } from "../../ui/button/button-atom.component";
import { taskTriggerId } from "./kanban.model";

@Component({
  selector: "praxis-kanban-card",
  imports: [ButtonAtom],
  templateUrl: "./kanban-card-molecule.component.html",
  styleUrl: "./kanban-card-molecule.component.css",
})
export class KanbanCardMolecule {
  readonly task = input.required<KanbanTask>();
  readonly opened = output<string>();
  protected readonly triggerId = taskTriggerId;
}
