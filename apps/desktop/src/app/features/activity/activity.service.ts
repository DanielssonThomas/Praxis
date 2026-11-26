import { Injectable, inject, signal } from "@angular/core";
import { DesktopBridge } from "../../native/desktop-bridge.service";
import type { ActivityCard, DecideActivityRequest, WorkflowError } from "../../native/desktop-bridge.service";

@Injectable({ providedIn: "root" })
export class ActivityService {
  private readonly bridge = inject(DesktopBridge);
  private revision = 0;
  private refreshing = false;
  readonly supported = this.bridge.available;
  readonly opened = signal(false);
  readonly unlocked = signal(false);
  readonly busy = signal(false);
  readonly cards = signal<readonly ActivityCard[]>([]);
  readonly status = signal("");

  toggle(): void {
    this.opened.update((opened) => !opened);
    if (this.opened()) void this.refresh();
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
      this.cards.set(result.data);
      this.unlocked.set(true);
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
    this.cards.set([]);
    this.unlocked.set(false);
    this.status.set("");
    try {
      await this.bridge.lockActivity();
    } catch {
      this.status.set("Activity could not be locked.");
    } finally {
      this.busy.set(false);
    }
  }

  async refresh(): Promise<void> {
    if (!this.opened() || !this.unlocked() || this.busy() || this.refreshing) return;
    const revision = this.revision;
    this.refreshing = true;
    try {
      const result = await this.bridge.readActivity();
      if (revision !== this.revision) return;
      if (result.status === "ok") {
        this.cards.set(result.data);
        if (this.status() === "No activity." && result.data.length) this.status.set("");
      } else {
        this.report(result.error);
      }
    } catch {
      if (revision === this.revision) this.status.set("Activity is unavailable.");
    } finally {
      this.refreshing = false;
    }
  }

  inspect(requestId: string): Promise<void> {
    return this.update(() => this.bridge.inspectActivity({ requestId }));
  }

  decide(request: DecideActivityRequest): Promise<void> {
    return this.update(() => this.bridge.decideActivity(request));
  }

  private async update(request: () => ReturnType<DesktopBridge["inspectActivity"]>): Promise<void> {
    if (this.busy() || !this.unlocked()) return;
    this.busy.set(true);
    ++this.revision;
    try {
      const result = await request();
      if (result.status === "error") {
        this.report(result.error);
      } else {
        this.cards.update((cards) => cards.map((card) => card.requestId === result.data.requestId ? result.data : card));
        this.status.set("");
      }
    } catch {
      this.status.set("The activity request failed.");
    } finally {
      this.busy.set(false);
      void this.refresh();
    }
  }

  private report(error: WorkflowError | undefined): void {
    if (error?.code === "locked" || error?.code === "denied") {
      this.unlocked.set(false);
      this.cards.set([]);
    }
    this.status.set(this.message(error));
  }

  private message(error: WorkflowError | undefined): string {
    return error?.code ? error.message : "Activity is unavailable.";
  }
}
