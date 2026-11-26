import { Component, computed, effect, inject, signal, untracked } from "@angular/core";
import type { ReportMetric, ReportPreferences, ReportResult } from "../../../generated/desktop-ipc";
import { DesktopBridge } from "../../native/desktop-bridge.service";
import { HostLaunchService } from "../../native/host-launch.service";
import { ButtonAtom } from "../../ui/button/button-atom.component";
import { OperatorUnlockMolecule } from "../../ui/operator-unlock/operator-unlock-molecule.component";
import { ReportChartMolecule } from "./chart/report-chart-molecule.component";
import { ReportPreferencesOrganism } from "./preferences/report-preferences-organism.component";
import { reportMetrics, reportRanges } from "./reports.model";

@Component({
  selector: "praxis-reports",
  imports: [ButtonAtom, OperatorUnlockMolecule, ReportChartMolecule, ReportPreferencesOrganism],
  templateUrl: "./reports-template.component.html",
  styleUrl: "./reports-template.component.css",
})
export class ReportsTemplate {
  private readonly bridge = inject(DesktopBridge);
  private readonly host = inject(HostLaunchService);
  protected readonly native = this.bridge.available;
  protected readonly ranges = reportRanges;
  protected readonly report = signal<ReportResult | null>(null);
  protected readonly busy = signal(false);
  protected readonly status = signal(this.native ? "" : "Open the Praxis desktop app to view local reports.");
  protected readonly confirmingClear = signal(false);
  protected readonly visible = signal<ReportMetric[]>([]);
  protected readonly activeMetrics = computed(() => reportMetrics.filter(({ metric }) => this.visible().includes(metric)));

  constructor() {
    effect(() => {
      if (this.native && this.host.status() === null) {
        untracked(() => { void this.request(() => this.bridge.readReports(this.report()?.days ?? 30)); });
      }
    });
  }

  protected unlock(credential: string): void {
    void this.request(() => this.bridge.unlockReports({ days: 30, credential }));
  }

  protected async lock(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.bridge.lockReports();
      this.report.set(null);
      this.visible.set([]);
      this.confirmingClear.set(false);
      this.status.set("");
    } catch {
      this.status.set("Local reports could not be locked.");
    } finally {
      this.busy.set(false);
    }
  }

  protected changeRange(select: HTMLSelectElement): void {
    void this.request(() => this.bridge.readReports(Number(select.value)));
  }

  protected savePreferences(preferences: ReportPreferences): void {
    const report = this.report();
    if (!report) return;
    void this.request(() => this.bridge.saveReportPreferences({ days: report.days, preferences }), "Report preferences saved.");
  }

  protected clearHistory(): void {
    const report = this.report();
    if (!report?.preferences.allowClearHistory || !this.confirmingClear()) return;
    this.confirmingClear.set(false);
    void this.request(() => this.bridge.clearReportHistory(report.days, { confirmed: true }), "Report history cleared.");
  }

  protected exportReport(): void {
    const report = this.report();
    if (!report?.preferences.allowExport || !report.preferences.collectionEnabled) return;
    const metrics = this.visible();
    const buckets = report.buckets.map(({ day, metrics: values }) => ({
      day, metrics: Object.fromEntries(metrics.map((metric) => [metric, values[metric] ?? null])),
    }));
    const blob = new Blob([JSON.stringify({ days: report.days, buckets }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "praxis-report.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  }

  private async request(work: () => ReturnType<DesktopBridge["readReports"]>, success = ""): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.status.set("Loading reports…");
    try {
      const result = await work();
      if (result.status === "error") {
        const credentialRequired = result.error.code === "operator_credential_required";
        if (credentialRequired || result.error.code === "operator_credential_rejected") {
          this.report.set(null);
          this.visible.set([]);
          this.confirmingClear.set(false);
        }
        this.status.set(credentialRequired ? "" : result.error.message);
        return;
      }
      this.report.set(result.data);
      this.visible.set(result.data.preferences.visibleMetrics);
      this.status.set(success);
    } catch {
      this.status.set("The local reports request did not complete.");
    } finally {
      this.busy.set(false);
    }
  }
}
