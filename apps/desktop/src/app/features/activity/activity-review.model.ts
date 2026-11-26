import type { ActivityCard } from "../../native/desktop-bridge.service";

export type ActivityReview = ActivityCard & {
  phase: Extract<ActivityCard["phase"], { state: "attention" }>;
};

export function isActivityReview(card: ActivityCard | undefined): card is ActivityReview {
  return card?.phase.state === "attention";
}

export function matchesActivityReview(card: ActivityCard | undefined, review: ActivityReview): boolean {
  return isActivityReview(card)
    && card.requestId === review.requestId
    && card.phase.approval.id === review.phase.approval.id
    && card.phase.expiresAt === review.phase.expiresAt
    && card.actorId === review.actorId
    && card.action.kind === review.action.kind
    && card.action.target.kind === review.action.target.kind
    && card.action.target.id === review.action.target.id;
}

export function approvalIsOpen(review: ActivityReview, now: number): boolean {
  return Date.parse(review.phase.expiresAt) > now;
}
