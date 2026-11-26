import { Component, ElementRef, computed, effect, input, signal, viewChild } from "@angular/core";
import type { Chart } from "chart.js";
import type { ReportBucket } from "../../../../generated/desktop-ipc";
import type { ReportMetricDisplay } from "../reports.model";

@Component({
  selector: "praxis-report-chart",
  templateUrl: "./report-chart-molecule.component.html",
  styleUrl: "./report-chart-molecule.component.css",
})
export class ReportChartMolecule {
  readonly display = input.required<ReportMetricDisplay>();
  readonly buckets = input.required<readonly ReportBucket[]>();
  readonly days = input.required<number>();
  protected readonly chartFailed = signal(false);
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>("chartCanvas");

  protected readonly latest = computed(() => {
    const { metric, digits } = this.display();
    const latest = [...this.buckets()].reverse().find((bucket) => bucket.metrics[metric] != null);
    const value = latest?.metrics[metric];
    if (latest === undefined || value === undefined || value === null) return null;
    const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
    return `${formatted} on ${latest.day}`;
  });

  constructor() {
    effect((onCleanup) => {
      const canvas = this.canvas()?.nativeElement;
      if (!canvas) return;
      const buckets = this.buckets();
      const { metric, label, digits } = this.display();
      let active = true;
      let chart: Chart<"line", (number | null)[], string> | undefined;
      onCleanup(() => {
        active = false;
        chart?.destroy();
      });
      this.chartFailed.set(false);
      void import("chart.js/auto").then(({ default: ChartLibrary }) => {
        if (!active) return;
        chart = new ChartLibrary(canvas, {
          type: "line",
          data: {
            labels: buckets.map(({ day }) => day),
            datasets: [{
              label,
              data: buckets.map((bucket) => bucket.metrics[metric] ?? null),
              spanGaps: false,
              borderColor: "#244db6",
              backgroundColor: "#244db6",
              pointRadius: 3,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: "nearest", intersect: false },
            plugins: { legend: { display: false } },
            scales: { x: { ticks: { maxTicksLimit: 5 } }, y: { beginAtZero: true, ticks: { precision: digits } } },
          },
        });
      }).catch(() => {
        if (active) this.chartFailed.set(true);
      });
    });
  }
}
