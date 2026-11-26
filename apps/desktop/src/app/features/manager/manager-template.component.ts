import { Component, inject } from "@angular/core";
import { ButtonAtom } from "../../ui/button/button-atom.component";
import { OperatorUnlockMolecule } from "../../ui/operator-unlock/operator-unlock-molecule.component";
import { ManagerConversationOrganism } from "./conversation/manager-conversation-organism.component";
import { ManagerService } from "./manager.service";

@Component({
  selector: "praxis-manager",
  imports: [ButtonAtom, OperatorUnlockMolecule, ManagerConversationOrganism],
  templateUrl: "./manager-template.component.html",
  styleUrl: "./manager-template.component.css",
})
export class ManagerTemplate {
  protected readonly manager = inject(ManagerService);
}
