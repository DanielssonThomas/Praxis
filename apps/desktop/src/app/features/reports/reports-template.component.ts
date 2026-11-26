import { afterRenderEffect, Component, computed, effect, ElementRef, inject, signal, untracked, viewChild } from "@angular/core";
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
  private readonly customizeButton = viewChild("customize", { read: ElementRef<HTMLButtonElement> });
  private readonly clearButton = viewChild("clear", { read: ElementRef<HTMLButtonElement> });
  private readonly keepButton = viewChild("keep", { read: ElementRef<HTMLButtonElement> });
  protected readonly native = this.bridge.available;
  protected readonly ranges = reportRanges;
  protected readonly report = signal<ReportResult | null>(null);
  protected readonly busy = signal(false);
  protected readonly status = signal(this.native ? "" : "Open the Praxis desktop app to view local reports.");
  protected readonly customizing = signal(false);
  protected readonly confirmingClear = signal(false);
  protected readonly draftMetrics = signal<ReportMetric[] | null>(null);

  private readonly savedMetrics = computed(() => this.report()?.preferences.visibleMetrics ?? []);
  protected readonly activeMetrics = computed(() => {
    const visible = this.draftMetrics() ?? this.savedMetrics();
    return reportMetrics.filter(({ metric }) => visible.includes(metric));
  });
  protected readonly unsavedMetrics = computed(() => {
    const draft = this.draftMetrics();
    const saved = this.savedMetrics();
    return draft !== null && (draft.length !== saved.length || draft.some((metric) => !saved.includes(metric)));
  });
  protected readonly exportAvailable = computed(() => {
    const preferences = this.report()?.preferences;
    return !!preferences?.allowExport && preferences.collectionEnabled && !this.busy() && !this.unsavedMetrics();
  });

  constructor() {
    effect(() => {
      if (this.native && this.host.status() === null) {
        untracked(() => { void this.request(() => this.bridge.readReports(this.report()?.days ?? 30)); });
      }
    });
    afterRenderEffect(() => {
      if (this.confirmingClear()) this.keepButton()?.nativeElement.focus();
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
      this.resetReport();
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

  protected toggleCustomization(): void {
    this.customizing.update((open) => !open);
    if (!this.customizing()) this.draftMetrics.set(null);
  }

  protected closeCustomization(event: Event): void {
    event.stopPropagation();
    this.toggleCustomization();
    this.customizeButton()?.nativeElement.focus();
  }

  protected async savePreferences(preferences: ReportPreferences): Promise<void> {
    const report = this.report();
    if (!report) return;
    const saved = await this.request(
      () => this.bridge.saveReportPreferences({ days: report.days, preferences }),
      "Report preferences saved.",
    );
    if (saved) this.draftMetrics.set(null);
  }

  protected keepHistory(event?: Event): void {
    event?.stopPropagation();
    this.confirmingClear.set(false);
    this.clearButton()?.nativeElement.focus();
  }

  protected clearHistory(): void {
    const report = this.report();
    if (!report?.preferences.allowClearHistory || !this.confirmingClear() || this.busy()) return;
    this.keepHistory();
    void this.request(() => this.bridge.clearReportHistory(report.days, { confirmed: true }), "Report history cleared.");
  }

  protected exportReport(): void {
    const report = this.report();
    if (!report || !this.exportAvailable()) return;
    const metrics = report.preferences.visibleMetrics;
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

  private resetReport(): void {
    this.report.set(null);
    this.draftMetrics.set(null);
    this.customizing.set(false);
    this.confirmingClear.set(false);
  }

  private async request(work: () => ReturnType<DesktopBridge["readReports"]>, success = ""): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    this.status.set("Loading reports…");
    try {
      const result = await work();
      if (result.status === "error") {
        const credentialRequired = result.error.code === "locked";
        if (credentialRequired || result.error.code === "denied") this.resetReport();
        this.status.set(credentialRequired ? "" : result.error.message);
        return false;
      }
      this.report.set(result.data);
      this.status.set(success);
      return true;
    } catch {
      this.status.set("The local reports request did not complete.");
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
