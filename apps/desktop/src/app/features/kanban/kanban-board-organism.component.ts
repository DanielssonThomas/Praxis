import { Component, input, output } from "@angular/core";
import type { KanbanIssueTarget } from "../../../generated/desktop-ipc";
import type { KanbanColumn } from "./kanban.model";
import { KanbanCardMolecule } from "./kanban-card-molecule.component";

@Component({
  selector: "praxis-kanban-board",
  imports: [KanbanCardMolecule],
  templateUrl: "./kanban-board-organism.component.html",
  styleUrl: "./kanban-board-organism.component.css",
})
export class KanbanBoardOrganism {
  readonly columns = input.required<KanbanColumn[]>();
  readonly canLink = input.required<boolean>();
  readonly busy = input.required<boolean>();
  readonly linkIssue = output<KanbanIssueTarget>();
  readonly openIssue = output<KanbanIssueTarget>();
  readonly invalidIssue = output<void>();
}
