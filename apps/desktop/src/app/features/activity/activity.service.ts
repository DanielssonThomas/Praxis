import { computed, DestroyRef, Injectable, inject, signal } from "@angular/core";
import { DesktopBridge } from "../../native/desktop-bridge.service";
import type { ActivityCard, DecideActivityRequest, OperatorDecision, WorkflowError } from "../../native/desktop-bridge.service";
import { approvalIsOpen, isActivityReview, matchesActivityReview } from "./activity-review.model";
import type { ActivityReview } from "./activity-review.model";

@Injectable({ providedIn: "root" })
export class ActivityService {
  private readonly bridge = inject(DesktopBridge);
  private readonly feedCurrent = signal(false);
  private revision = 0;
  private refreshing = false;

  readonly supported = this.bridge.available;
  readonly opened = signal(false);
  readonly unlocked = signal(false);
  readonly busy = signal(false);
  readonly cards = signal<readonly ActivityCard[]>([]);
  readonly status = signal("");
  readonly now = signal(Date.now());
  readonly attentionCount = computed(() => {
    if (!this.unlocked() || !this.feedCurrent()) return 0;
    const now = this.now();
    return this.cards().filter((card) => isActivityReview(card) && approvalIsOpen(card, now)).length;
  });

  constructor() {
    if (!this.supported) return;
    const timer = setInterval(() => {
      this.now.set(Date.now());
      void this.refresh();
    }, 1_500);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  toggle(): void {
    this.opened.update((opened) => !opened);
    if (this.opened()) void this.refresh();
  }

  close(): void {
    this.opened.set(false);
  }

  async unlock(token: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    ++this.revision;
    try {
      const result = await this.bridge.unlockActivity(token);
      if (result.status === "error") {
        this.status.set(this.message(result.error));
        return;
      }
      this.unlocked.set(true);
      this.acceptFeed(result.data);
      this.status.set(result.data.length ? "" : "No activity.");
    } catch {
      this.status.set("Activity could not be opened.");
    } finally {
      this.busy.set(false);
    }
  }

  async lock(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    ++this.revision;
    this.clearFeed();
    this.status.set("");
    try {
      await this.bridge.lockActivity();
    } catch {
      this.status.set("Activity could not be locked.");
    } finally {
      this.busy.set(false);
    }
  }

  private async refresh(preserveFeedback = false): Promise<void> {
    if (!this.unlocked() || this.busy() || this.refreshing) return;
    const revision = this.revision;
    this.refreshing = true;
    try {
      const result = await this.bridge.readActivity();
      if (revision !== this.revision) return;
      if (result.status === "ok") {
        const recovering = !this.feedCurrent();
        this.acceptFeed(result.data);
        if ((recovering && !preserveFeedback) || this.status() === "No activity.") {
          this.status.set(result.data.length ? "" : "No activity.");
        }
      } else {
        this.feedCurrent.set(false);
        this.report(result.error);
      }
    } catch {
      if (revision === this.revision) {
        this.feedCurrent.set(false);
        this.status.set("Activity is unavailable.");
      }
    } finally {
      this.refreshing = false;
    }
  }

  inspect(requestId: string): Promise<void> {
    return this.update(() => this.bridge.inspectActivity({ requestId }));
  }

  canDecide(review: ActivityReview, now = this.now()): boolean {
    return this.unlocked() && this.feedCurrent() && !this.busy()
      && approvalIsOpen(review, now)
      && matchesActivityReview(this.cards().find(({ requestId }) => requestId === review.requestId), review);
  }

  async decide(review: ActivityReview, decision: OperatorDecision): Promise<void> {
    if (!this.canDecide(review, Date.now())) return;
    const request: DecideActivityRequest = {
      requestId: review.requestId, approvalId: review.phase.approval.id, decision,
    };
    await this.update(() => this.bridge.decideActivity(request));
  }

  private async update(request: () => ReturnType<DesktopBridge["inspectActivity"]>): Promise<void> {
    if (this.busy() || !this.unlocked()) return;
    this.busy.set(true);
    ++this.revision;
    try {
      const result = await request();
      if (result.status === "error") {
        const code = result.error?.code;
        if (code === "conflict" || code === "invalid_input") {
          this.feedCurrent.set(false);
        }
        this.report(result.error);
      } else {
        this.cards.update((cards) => cards.map((card) => card.requestId === result.data.requestId ? result.data : card));
        this.status.set("");
      }
    } catch {
      this.status.set("The activity request failed.");
    } finally {
      this.busy.set(false);
      void this.refresh(true);
    }
  }

  private acceptFeed(cards: readonly ActivityCard[]): void {
    this.now.set(Date.now());
    this.cards.set(cards);
    this.feedCurrent.set(true);
  }

  private clearFeed(): void {
    this.unlocked.set(false);
    this.cards.set([]);
    this.feedCurrent.set(false);
  }

  private report(error: WorkflowError | undefined): void {
    if (error?.code === "locked" || error?.code === "denied") this.clearFeed();
    this.status.set(this.message(error));
  }

  private message(error: WorkflowError | undefined): string {
    return error?.code ? error.message : "Activity is unavailable.";
  }
}
