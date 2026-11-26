import { Component, inject } from "@angular/core";
import { ButtonAtom } from "../../ui/button/button-atom.component";
import { OperatorUnlockMolecule } from "../../ui/operator-unlock/operator-unlock-molecule.component";
import { KanbanBoardOrganism } from "./kanban-board-organism.component";
import { KanbanService } from "./kanban.service";

@Component({
  selector: "praxis-kanban",
  imports: [ButtonAtom, OperatorUnlockMolecule, KanbanBoardOrganism],
  providers: [KanbanService],
  templateUrl: "./kanban-template.component.html",
  styleUrl: "./kanban-template.component.css",
})
export class KanbanTemplate {
  protected readonly kanban = inject(KanbanService);
}
