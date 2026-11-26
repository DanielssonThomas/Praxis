import { Injectable } from "@angular/core";
import { isTauri } from "@tauri-apps/api/core";
import { commands } from "../../generated/desktop-ipc";

@Injectable({ providedIn: "root" })
export class DesktopBridge {
  readonly available = isTauri();
  readonly hostStatus = commands.hostStatus;
  readonly retryHost = commands.retryHost;
  readonly kanbanList = commands.kanbanList;
  readonly kanbanUnlock = commands.kanbanUnlock;
  readonly kanbanLock = commands.kanbanLock;
  readonly kanbanLinkIssue = commands.kanbanLinkIssue;
  readonly kanbanOpenIssue = commands.kanbanOpenIssue;
}
