import { Injectable } from "@angular/core";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { commands } from "../../generated/desktop-ipc";
import type { ManagerFrame, ManagerTurnRequest } from "../../generated/desktop-ipc";

export type {
  ManagerFrame, ManagerMessage, ManagerResource, OverviewPane, OverviewProjection,
  UsageMeasurement, WorkflowError,
} from "../../generated/desktop-ipc";

@Injectable({ providedIn: "root" })
export class DesktopBridge {
  readonly available = isTauri();
  readonly hostStatus = commands.hostStatus;
  readonly retryHost = commands.retryHost;
  readonly unlockManager = commands.unlockManager;
  readonly lockManager = commands.lockManager;
  readonly unlockOverview = commands.unlockOverview;
  readonly lockOverview = commands.lockOverview;
  readonly readOverview = commands.readOverview;
  readonly kanbanList = commands.kanbanList;
  readonly kanbanUnlock = commands.kanbanUnlock;
  readonly kanbanLock = commands.kanbanLock;
  readonly kanbanLinkIssue = commands.kanbanLinkIssue;
  readonly kanbanOpenIssue = commands.kanbanOpenIssue;

  managerTurn(request: ManagerTurnRequest, onFrame: (frame: ManagerFrame) => void) {
    const output = new Channel<ManagerFrame>();
    output.onmessage = onFrame;
    return commands.managerTurn(request, output);
  }
}
