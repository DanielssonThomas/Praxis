import { DestroyRef, Injectable, inject, signal } from "@angular/core";
import { invoke, isTauri } from "@tauri-apps/api/core";

@Injectable({ providedIn: "root" })
export class HostLaunchService {
  readonly native = isTauri();
  readonly status = signal<string | null>("Starting the local Praxis host.");
  readonly retrying = signal(false);
  private refreshing = false;

  constructor() {
    if (!this.native) return;
    void this.refresh();
    const poll = setInterval(() => { void this.refresh(); }, 250);
    inject(DestroyRef).onDestroy(() => clearInterval(poll));
  }

  async retry(): Promise<void> {
    this.retrying.set(true);
    try {
      await invoke<void>("retry_host");
      await this.refresh();
    } catch {
      this.status.set("The local Praxis host could not restart.");
    } finally {
      this.retrying.set(false);
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.status.set(await invoke<string | null>("host_launch_status"));
    } catch {
      this.status.set("The local Praxis host status is unavailable.");
    } finally {
      this.refreshing = false;
    }
  }
}
