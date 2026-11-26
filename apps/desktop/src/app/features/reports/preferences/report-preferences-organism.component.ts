import { Component, input, output } from "@angular/core";
import type { ReportMetric, ReportPreferences } from "../../../../generated/desktop-ipc";
import { ButtonAtom } from "../../../ui/button/button-atom.component";
import { reportMetrics, reportRanges } from "../reports.model";

@Component({
  selector: "praxis-report-preferences",
  imports: [ButtonAtom],
  templateUrl: "./report-preferences-organism.component.html",
  styleUrl: "./report-preferences-organism.component.css",
})
export class ReportPreferencesOrganism {
  readonly preferences = input.required<ReportPreferences>();
  readonly busy = input(false);
  readonly submitted = output<ReportPreferences>();
  readonly metricsChanged = output<ReportMetric[]>();
  protected readonly metrics = reportMetrics;
  protected readonly ranges = reportRanges;

  protected preview(form: HTMLFormElement): void {
    this.metricsChanged.emit(this.selectedMetrics(new FormData(form)));
  }

  protected submit(event: SubmitEvent): void {
    event.preventDefault();
    if (this.busy() || !(event.currentTarget instanceof HTMLFormElement)) return;
    const fields = new FormData(event.currentTarget);
    this.submitted.emit({
      collectionEnabled: fields.has("collectionEnabled"),
      retentionDays: Number(fields.get("retentionDays")),
      visibleMetrics: this.selectedMetrics(fields),
      allowExport: fields.has("allowExport"),
      allowClearHistory: fields.has("allowClearHistory"),
    });
  }

  private selectedMetrics(fields: FormData): ReportMetric[] {
    return this.metrics.filter(({ metric }) => fields.has(`metric_${metric}`)).map(({ metric }) => metric);
  }
}
