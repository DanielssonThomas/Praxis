import { afterRenderEffect, Component, computed, ElementRef, inject, output, signal, viewChild } from "@angular/core";
import type { ActivityCard, OperatorDecision } from "../../native/desktop-bridge.service";
import { ButtonAtom } from "../../ui/button/button-atom.component";
import { OperatorUnlockMolecule } from "../../ui/operator-unlock/operator-unlock-molecule.component";
import { ActivityService } from "./activity.service";
import { approvalIsOpen, isActivityReview, matchesActivityReview } from "./activity-review.model";
import type { ActivityReview } from "./activity-review.model";
import { ActivityCardMolecule } from "./card/activity-card-molecule.component";
import { ActivityReviewMolecule } from "./review/activity-review-molecule.component";

@Component({
  selector: "praxis-activity-panel",
  imports: [ButtonAtom, OperatorUnlockMolecule, ActivityCardMolecule, ActivityReviewMolecule],
  templateUrl: "./activity-panel-organism.component.html",
  styleUrl: "./activity-panel-organism.component.css",
})
export class ActivityPanelOrganism {
  readonly dismissed = output<void>();

  protected readonly activity = inject(ActivityService);
  protected readonly review = signal<ActivityReview | null>(null);
  protected readonly latest = computed(() => {
    const review = this.review();
    return review && this.activity.unlocked()
      ? this.activity.cards().find(({ requestId }) => requestId === review.requestId)
      : undefined;
  });
  protected readonly notice = computed(() => {
    const review = this.review();
    const latest = this.latest();
    if (!review) return "";
    if (!latest) return "This request is no longer in the Activity feed.";
    if (!isActivityReview(latest)) return "";
    if (!matchesActivityReview(latest, review)) return "Approval details changed. Close this review and open the current request.";
    if (!approvalIsOpen(review, this.activity.now())) return "The approval deadline passed.";
    return "";
  });

  private readonly heading = viewChild.required<ElementRef<HTMLHeadingElement>>("heading");
  private reviewButton?: HTMLButtonElement;
  private reviewCard?: HTMLElement;

  constructor() {
    afterRenderEffect(() => {
      if (this.activity.opened()) this.heading().nativeElement.focus();
    });
    afterRenderEffect(() => {
      if (!this.activity.unlocked() && this.review()) this.dismissReview();
    });
  }

  protected startReview(card: ActivityCard, trigger: HTMLButtonElement): void {
    if (!this.activity.unlocked() || !isActivityReview(card)) return;
    this.reviewButton = trigger;
    this.reviewCard = trigger.closest("article") ?? undefined;
    this.activity.status.set("");
    this.review.set(card);
  }

  protected dismissReview(): void {
    this.review.set(null);
    const trigger = this.reviewButton;
    const card = this.reviewCard;
    this.reviewButton = undefined;
    this.reviewCard = undefined;
    if (trigger?.isConnected && !trigger.disabled) trigger.focus();
    else if (card?.isConnected) card.focus();
    else this.heading().nativeElement.focus();
  }

  protected dismissInbox(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.activity.close();
    this.dismissed.emit();
  }

  protected decide(decision: OperatorDecision): void {
    const review = this.review();
    if (review) void this.activity.decide(review, decision);
  }
}
