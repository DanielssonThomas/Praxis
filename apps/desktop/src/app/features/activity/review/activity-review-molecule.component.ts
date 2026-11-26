import { afterNextRender, afterRenderEffect, Component, computed, ElementRef, input, output, viewChild } from "@angular/core";
import type { ActivityCard, OperatorDecision } from "../../../native/desktop-bridge.service";
import { ButtonAtom } from "../../../ui/button/button-atom.component";
import { activityActionLabel, activityDetail, activityLabels } from "../activity-presentation";
import type { ActivityReview } from "../activity-review.model";

@Component({
  selector: "praxis-activity-review",
  imports: [ButtonAtom],
  templateUrl: "./activity-review-molecule.component.html",
  styleUrl: "./activity-review-molecule.component.css",
})
export class ActivityReviewMolecule {
  readonly reviewed = input.required<ActivityReview>();
  readonly latest = input<ActivityCard>();
  readonly enabled = input.required<boolean>();
  readonly notice = input.required<string>();
  readonly status = input.required<string>();
  readonly dismissed = output<void>();
  readonly decided = output<OperatorDecision>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>("dialog");
  private readonly closeButton = viewChild.required("closeButton", { read: ElementRef<HTMLButtonElement> });

  protected readonly title = computed(() => activityActionLabel(this.reviewed().action.kind));
  protected readonly label = computed(() => {
    const phase = this.latest()?.phase;
    return phase ? activityLabels[phase.state] : "Request unavailable";
  });
  protected readonly detail = computed(() => {
    const phase = this.latest()?.phase;
    return phase ? activityDetail(phase) : "";
  });
  protected readonly expiry = computed(() => new Date(this.reviewed().phase.expiresAt).toLocaleString(undefined, {
    dateStyle: "medium", timeStyle: "long",
  }));

  constructor() {
    afterNextRender(() => {
      this.dialog().nativeElement.showModal();
      this.closeButton().nativeElement.focus();
    });
    afterRenderEffect(() => {
      if (!this.enabled() && this.dialog().nativeElement.open) this.closeButton().nativeElement.focus();
    });
  }

  protected close(event?: Event): void {
    event?.preventDefault();
    this.dialog().nativeElement.close();
    this.dismissed.emit();
  }
}
