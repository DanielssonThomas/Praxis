import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";
import type { KanbanBoard, KanbanError, KanbanIssueTarget, KanbanLinkReceipt } from "../../../generated/desktop-ipc";
import { DesktopBridge } from "../../native/desktop-bridge.service";
import { HostLaunchService } from "../../native/host-launch.service";
import { groupByNativeStatus } from "./kanban.model";
import type { KanbanStage, KanbanTaskFeedback } from "./kanban.model";

const unavailableMessage = "The desktop task board is unavailable.";
const operatorMessage = "An operator credential is required.";

@Injectable()
export class KanbanService {
  private readonly bridge = inject(DesktopBridge);
  private readonly host = inject(HostLaunchService);
  private readonly board = signal<KanbanBoard | null>(null);
  readonly stage = signal<KanbanStage>("loading");
  readonly busy = signal(false);
  readonly status = signal("Loading the native task board.");
  readonly taskFeedback = signal<KanbanTaskFeedback | null>(null);
  readonly columns = computed(() => groupByNativeStatus(this.board()?.tasks ?? []));
  readonly canLink = computed(() => this.board()?.provider.available === true);
  readonly providerMessage = computed(() => {
    const provider = this.board()?.provider;
    return provider && !provider.available
      ? provider.reason ?? "GitHub issue linking is unavailable."
      : "";
  });

  constructor() {
    if (!this.bridge.available) {
      this.stage.set("unavailable");
      this.status.set(unavailableMessage);
      return;
    }
    effect(() => {
      const ready = this.host.runtimeVersion() !== null;
      const failed = this.host.canRetry();
      untracked(() => {
        if (ready) {
          void this.refresh();
        } else if (failed) {
          this.board.set(null);
          this.stage.set("unavailable");
          this.status.set(unavailableMessage);
        }
      });
    });
  }

  refresh(): Promise<void> {
    return this.load(() => this.bridge.kanbanList());
  }

  unlock(credential: string): Promise<void> {
    return this.load(() => this.bridge.kanbanUnlock(credential));
  }

  async lock(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.bridge.kanbanLock();
      this.setLocked();
      this.status.set("Kanban is locked.");
    } catch {
      this.status.set("The Kanban session could not be locked.");
    } finally {
      this.busy.set(false);
    }
  }

  async link(target: KanbanIssueTarget): Promise<void> {
    if (this.busy() || !this.canLink()) return;
    this.busy.set(true);
    this.showTaskFeedback(target.nativeId, "Verifying the GitHub issue.");
    try {
      const result = await this.bridge.kanbanLinkIssue(target);
      if (result.status === "error") this.showActionFailure(target.nativeId, result.error);
      else {
        this.addVerifiedIssue(result.data);
        this.showTaskFeedback(target.nativeId, "GitHub issue linked.");
      }
    } catch {
      this.showTaskFeedback(target.nativeId, "The issue link is unavailable.");
    } finally {
      this.busy.set(false);
    }
  }

  async open(target: KanbanIssueTarget): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const result = await this.bridge.kanbanOpenIssue(target);
      if (result.status === "error") this.showActionFailure(target.nativeId, result.error);
      else this.showTaskFeedback(target.nativeId, "GitHub issue opened in the browser.");
    } catch {
      this.showTaskFeedback(target.nativeId, "The GitHub issue could not open in the browser.");
    } finally {
      this.busy.set(false);
    }
  }

  invalidIssue(nativeId: string): void {
    this.showTaskFeedback(nativeId, "Enter a GitHub issue as owner/repo#42.");
  }

  private async load(
    request: DesktopBridge["kanbanList"],
  ): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.taskFeedback.set(null);
    this.status.set("Loading the native task board.");
    try {
      const result = await request();
      if (result.status === "ok") {
        this.board.set(result.data);
        this.stage.set("ready");
        this.status.set(result.data.tasks.length ? "" : "No tasks on the selected Hermes board.");
      } else if (result.error?.kind === "operator_required") {
        this.setLocked();
        this.status.set(operatorMessage);
      } else if (result.error?.kind === "setup_required") {
        this.board.set(null);
        this.stage.set("setup");
        this.status.set("Configure the local Hermes board to view its tasks.");
      } else {
        this.stage.set(this.board() ? "ready" : "unavailable");
        this.status.set(errorMessage(result.error));
      }
    } catch {
      this.stage.set(this.board() ? "ready" : "unavailable");
      this.status.set(unavailableMessage);
    } finally {
      this.busy.set(false);
    }
  }

  private setLocked(): void {
    this.board.set(null);
    this.taskFeedback.set(null);
    this.stage.set("locked");
  }

  private showActionFailure(nativeId: string, error: KanbanError): void {
    if (error?.kind === "operator_required") {
      this.setLocked();
      this.status.set(errorMessage(error));
      return;
    }
    this.showTaskFeedback(nativeId, errorMessage(error));
  }

  private showTaskFeedback(nativeId: string, message: string): void {
    this.taskFeedback.set({ nativeId, message });
  }

  private addVerifiedIssue({ taskId, issue }: KanbanLinkReceipt): void {
    this.board.update((board) => board && ({
      ...board,
      tasks: board.tasks.map((task) => (
        task.task.id === taskId && !task.links.some((link) =>
          link.repository === issue.repository && link.number === issue.number
        )
          ? { ...task, links: [...task.links, issue] }
          : task
      )),
    }));
  }
}

function errorMessage(error: KanbanError | undefined): string {
  switch (error?.kind) {
    case "host": return error.details.message;
    case "operator_required": return operatorMessage;
    case "scope_unavailable": return "The configured operator scope is unavailable for this board.";
    case "invalid_issue": return "Enter a valid GitHub issue as owner/repo#42.";
    case "issue_not_found": return "The task or GitHub issue is unavailable.";
    case "provider_denied": return "GitHub did not authorize access to this issue.";
    case "browser_unavailable": return "The GitHub issue could not open in the browser.";
    default: return unavailableMessage;
  }
}
