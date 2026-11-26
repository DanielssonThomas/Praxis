import { Injectable, inject, signal } from "@angular/core";
import { DesktopBridge } from "../../native/desktop-bridge.service";
import type { OverviewProjection, SessionControlRequest, WorkflowError } from "../../native/desktop-bridge.service";

@Injectable({ providedIn: "root" })
export class OverviewService {
  private readonly native = inject(DesktopBridge);
  private revision = 0;
  private reading = false;
  private readonly operations = signal(0);
  readonly projection = signal<OverviewProjection | null>(null);
  readonly expanded = signal<string | null>(null);
  readonly unlocked = signal(false);
  readonly unlocking = signal(false);
  readonly paging = signal(false);
  readonly canUnlock = signal(this.native.available);
  readonly status = signal(this.native.available ? "Connecting to Overview…" : "The desktop worker connection is unavailable.");

  async unlock(token: string): Promise<void> {
    if (this.unlocking()) return;
    this.unlocking.set(true);
    const revision = ++this.revision;
    try {
      const result = await this.native.unlockOverview(token);
      if (revision !== this.revision) return;
      if (result.status === "error") this.failure(result.error);
      else this.accept(result.data);
    } catch {
      if (revision === this.revision) this.failure(undefined);
    } finally {
      this.unlocking.set(false);
    }
  }

  async lock(): Promise<void> {
    this.unlocking.set(true);
    ++this.revision;
    this.unlocked.set(false);
    this.projection.set(null);
    this.expanded.set(null);
    this.paging.set(false);
    this.status.set("Overview locked.");
    this.canUnlock.set(true);
    try {
      await this.native.lockOverview();
    } catch {
      this.failure(undefined);
    } finally {
      this.unlocking.set(false);
    }
  }

  async refresh(): Promise<void> {
    if (!this.native.available || this.reading || this.unlocking() || this.paging() || this.operations() > 0) return;
    this.reading = true;
    try {
      await this.read(this.projection()?.page.number ?? 1, this.revision);
    } finally {
      this.reading = false;
    }
  }

  canStep(delta: -1 | 1): boolean {
    const page = this.projection()?.page;
    if (!page || this.unlocking() || this.paging() || this.operations() > 0) return false;
    const target = page.number + delta;
    return target >= 1 && target <= page.count;
  }

  async step(delta: -1 | 1): Promise<void> {
    const page = this.projection()?.page;
    if (!page || !this.canStep(delta)) return;
    const revision = ++this.revision;
    this.paging.set(true);
    this.expanded.set(null);
    try {
      await this.read(page.number + delta, revision);
    } finally {
      if (revision === this.revision) this.paging.set(false);
    }
  }

  expand(id: string): void {
    if (this.paging()) return;
    this.expanded.update((current) => current === id ? null : id);
  }

  async operate(request: SessionControlRequest) {
    if (this.paging() || !this.projection()?.panes.some((pane) => pane.session.id === request.sessionId)) {
      return {
        status: "error" as const,
        error: { code: "conflict", message: "The worker is no longer on this page." } satisfies WorkflowError,
      };
    }
    this.operations.update((count) => count + 1);
    const revision = ++this.revision;
    try {
      const result = await this.native.controlSession(request);
      if (result.status === "ok" && revision === this.revision) {
        this.projection.update((projection) => projection && ({
          ...projection,
          panes: projection.panes.map((pane) => pane.session.id === request.sessionId
            ? { ...pane, control: result.data } : pane),
        }));
      }
      return result;
    } finally {
      this.operations.update((count) => count - 1);
    }
  }

  private async read(page: number, revision: number): Promise<void> {
    try {
      const result = await this.native.readOverview(page);
      if (revision !== this.revision) return;
      if (result.status === "error") this.failure(result.error);
      else this.accept(result.data);
    } catch {
      if (revision === this.revision) this.failure(undefined);
    }
  }

  private accept(projection: OverviewProjection): void {
    if (this.projection()?.page.number !== projection.page.number) this.expanded.set(null);
    this.unlocked.set(true);
    this.projection.set(projection);
    if (!projection.panes.some((pane) => pane.session.id === this.expanded())) this.expanded.set(null);
    this.status.set(projection.panes.length ? "" : "No native session assignments are registered.");
  }

  private failure(error: WorkflowError | undefined): void {
    if (error?.code === "locked" || error?.code === "denied" || error?.code === "setup_required") {
      this.unlocked.set(false);
      this.projection.set(null);
      this.expanded.set(null);
      this.canUnlock.set(error.code !== "setup_required");
    }
    this.status.set(error?.code ? error.message : "The native worker overview is unavailable. Reconnect to retry.");
  }
}
