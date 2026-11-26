import { Component, DestroyRef, inject } from "@angular/core";
import { ButtonAtom } from "../../ui/button/button-atom.component";
import { OperatorUnlockMolecule } from "../../ui/operator-unlock/operator-unlock-molecule.component";
import { OverviewService } from "./overview.service";
import { OverviewWorkerOrganism } from "./worker/overview-worker-organism.component";

@Component({
  selector: "praxis-overview",
  imports: [ButtonAtom, OperatorUnlockMolecule, OverviewWorkerOrganism],
  templateUrl: "./overview-template.component.html",
  styleUrl: "./overview-template.component.css",
})
export class OverviewTemplate {
  protected readonly overview = inject(OverviewService);

  constructor() {
    void this.overview.refresh();
    const timer = setInterval(() => { void this.overview.refresh(); }, 1_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
}
