import { DestroyRef, Injectable, inject, signal } from "@angular/core";
import { DesktopBridge } from "./desktop-bridge.service";

@Injectable({ providedIn: "root" })
export class HostLaunchService {
  private readonly bridge = inject(DesktopBridge);
  readonly native = this.bridge.available;
  readonly status = signal<string | null>("Starting the local Praxis host.");
  readonly runtimeVersion = signal<string | null>(null);
  readonly canRetry = signal(false);
  readonly retrying = signal(false);
  private refreshing = false;
  private destroyed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    if (!this.native) return;
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      clearTimeout(this.timer);
    });
    void this.refresh();
  }

  async retry(): Promise<void> {
    this.retrying.set(true);
    try {
      const result = await this.bridge.retryHost();
      if (result.status === "error") {
        this.reportFailure("The local Praxis host could not restart.");
        return;
      }
      await this.refresh();
    } catch {
      this.reportFailure("The local Praxis host could not restart.");
    } finally {
      this.retrying.set(false);
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    let nextPoll = 750;
    try {
      const result = await this.bridge.hostStatus();
      if (result.status === "error") {
        const error = result.error;
        const known = error?.code === "host_unavailable" || error?.code === "host_timed_out"
          || error?.code === "invalid_host_response";
        this.reportFailure(known ? error.message : "The local Praxis host status is unavailable.");
        return;
      }
      const starting = result.data.stage === "starting";
      this.status.set(starting ? "Starting the local Praxis host." : null);
      this.runtimeVersion.set(result.data.nodeVersion);
      this.canRetry.set(false);
      nextPoll = result.data.retryAfterMs ?? nextPoll;
    } catch {
      this.reportFailure("The local Praxis host status is unavailable.");
    } finally {
      this.refreshing = false;
      clearTimeout(this.timer);
      if (!this.destroyed) this.timer = setTimeout(() => { void this.refresh(); }, nextPoll);
    }
  }

  private reportFailure(message: string): void {
    this.status.set(message);
    this.runtimeVersion.set(null);
    this.canRetry.set(true);
  }
}
