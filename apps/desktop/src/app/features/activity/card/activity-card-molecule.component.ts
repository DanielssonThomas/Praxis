import { Component, computed, ElementRef, input, output, viewChild } from "@angular/core";
import type { ActivityCard } from "../../../native/desktop-bridge.service";
import { ButtonAtom } from "../../../ui/button/button-atom.component";
import { activityActionLabel, activityDetail, activityLabels } from "../activity-presentation";

@Component({
  selector: "praxis-activity-card",
  imports: [ButtonAtom],
  templateUrl: "./activity-card-molecule.component.html",
  styleUrl: "./activity-card-molecule.component.css",
})
export class ActivityCardMolecule {
  readonly card = input.required<ActivityCard>();
  readonly busy = input.required<boolean>();
  readonly inspectRequested = output<string>();
  readonly reviewRequested = output<HTMLButtonElement>();

  protected readonly label = computed(() => activityLabels[this.card().phase.state]);
  protected readonly title = computed(() => activityActionLabel(this.card().action.kind));
  protected readonly detail = computed(() => activityDetail(this.card().phase));
  private readonly reviewButton = viewChild.required("reviewButton", { read: ElementRef<HTMLButtonElement> });

  protected startReview(): void {
    this.reviewRequested.emit(this.reviewButton().nativeElement);
  }
}
