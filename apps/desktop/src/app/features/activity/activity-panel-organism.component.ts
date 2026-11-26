import { Component, DestroyRef, inject } from "@angular/core";
import { ButtonAtom } from "../../ui/button/button-atom.component";
import { OperatorUnlockMolecule } from "../../ui/operator-unlock/operator-unlock-molecule.component";
import { ActivityService } from "./activity.service";
import { ActivityCardMolecule } from "./card/activity-card-molecule.component";

@Component({
  selector: "praxis-activity-panel",
  imports: [ButtonAtom, OperatorUnlockMolecule, ActivityCardMolecule],
  templateUrl: "./activity-panel-organism.component.html",
  styleUrl: "./activity-panel-organism.component.css",
})
export class ActivityPanelOrganism {
  protected readonly activity = inject(ActivityService);

  constructor() {
    const timer = setInterval(() => { void this.activity.refresh(); }, 1_500);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
}
