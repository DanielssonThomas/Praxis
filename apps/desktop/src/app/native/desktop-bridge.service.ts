import { Injectable } from "@angular/core";
import { isTauri } from "@tauri-apps/api/core";
import { commands } from "../../generated/desktop-ipc";

@Injectable({ providedIn: "root" })
export class DesktopBridge {
  readonly available = isTauri();
  readonly hostStatus = commands.hostStatus;
  readonly retryHost = commands.retryHost;
}
