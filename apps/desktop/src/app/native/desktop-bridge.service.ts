import { Injectable } from "@angular/core";
import { isTauri } from "@tauri-apps/api/core";
import { commands } from "../../generated/desktop-ipc";

@Injectable({ providedIn: "root" })
export class DesktopBridge {
  readonly available = isTauri();
  readonly hostStatus = commands.hostStatus;
  readonly retryHost = commands.retryHost;
  readonly readSettings = commands.readSettings;
  readonly saveSettings = commands.saveSettings;
  readonly unlockReports = commands.unlockReports;
  readonly lockReports = commands.lockReports;
  readonly readReports = commands.readReports;
  readonly saveReportPreferences = commands.saveReportPreferences;
  readonly clearReportHistory = commands.clearReportHistory;
}
