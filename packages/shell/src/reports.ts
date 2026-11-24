import type { Chart } from "chart.js";
import type { ReportDays, ReportMetric } from "@praxis/settings";
import type { ReportResult } from "./report-projection.js";

const metrics = {
  prsOpened: { label: "PRs opened (recorded)", digits: 0 },
  prsMerged: { label: "PRs merged (recorded)", digits: 0 },
  ticketsCompleted: { label: "Tickets completed (recorded)", digits: 0 },
  taskMinutes: { label: "Average task duration (min)", digits: 1 },
  tokens: { label: "Reported tokens", digits: 0 },
  costUsd: { label: "Reported cost (USD)", digits: 4 },
  interventions: { label: "Operator interventions", digits: 0 },
} satisfies Record<ReportMetric, { label: string; digits: number }>;
const entries = Object.entries(metrics) as [ReportMetric, (typeof metrics)[ReportMetric]][];

type ChartConstructor = typeof Chart;
type ReportChart = Chart<"line", (number | null)[], string>;
const chartWindow = window as Window & { Chart?: ChartConstructor };
const auth = document.querySelector<HTMLFormElement>("#reports-auth")!;
const status = document.querySelector<HTMLParagraphElement>("#reports-status")!;
const lock = document.querySelector<HTMLButtonElement>("#reports-lock")!;
const content = document.querySelector<HTMLElement>("#reports-content")!;
const range = document.querySelector<HTMLSelectElement>("#reports-range")!;
const note = document.querySelector<HTMLParagraphElement>("#reports-note")!;
const charts = document.querySelector<HTMLDivElement>("#reports-charts")!;
const form = document.querySelector<HTMLFormElement>("#reports-options")!;
const metricOptions = document.querySelector<HTMLFieldSetElement>("#reports-metrics")!;
const localOptions = document.querySelector<HTMLFieldSetElement>("#reports-local-preferences")!;
const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const exportButton = document.querySelector<HTMLButtonElement>("#reports-export")!;
const clear = document.querySelector<HTMLButtonElement>("#reports-clear")!;
let token = "";
let result: ReportResult | undefined;
let chartLoader: Promise<ChartConstructor> | undefined;
let activeCharts: ReportChart[] = [];
let busy = false;

for (const [key, { label }] of entries) {
  const option = document.createElement("input");
  option.type = "checkbox";
  option.name = key;
  const text = document.createElement("label");
  text.append(option, ` ${label}`);
  metricOptions.append(text);
}

function input(name: string): HTMLInputElement {
  return form.elements.namedItem(name) as HTMLInputElement;
}

function retention(): HTMLSelectElement {
  return form.elements.namedItem("retentionDays") as HTMLSelectElement;
}

function selectedMetrics(): ReportMetric[] {
  return entries.filter(([key]) => input(key).checked).map(([key]) => key);
}

function destroyCharts(): void {
  for (const chart of activeCharts) chart.destroy();
  activeCharts = [];
  charts.replaceChildren();
}

function chartLibrary(): Promise<ChartConstructor> {
  chartLoader ??= new Promise<ChartConstructor>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/assets/chart.js";
    script.onload = () => {
      if (chartWindow.Chart) resolve(chartWindow.Chart);
      else reject(new Error("The local chart library did not start."));
    };
    script.onerror = () => reject(new Error("The local chart library could not be loaded."));
    document.head.append(script);
  }).catch((error) => {
    chartLoader = undefined;
    throw error;
  });
  return chartLoader;
}

function renderCharts(): void {
  destroyCharts();
  const ChartLibrary = chartWindow.Chart;
  if (!result?.preferences.collectionEnabled || ChartLibrary === undefined) return;

  for (const metric of selectedMetrics()) {
    const { label, digits } = metrics[metric];
    const points = result.buckets.map((bucket) => bucket.metrics[metric]);
    let last = points.length - 1;
    while (last >= 0 && points[last] === null) last--;
    const card = document.createElement("article");
    card.className = "report-metric";
    const title = document.createElement("h2");
    title.textContent = label;
    const summary = document.createElement("p");
    summary.textContent = last === -1
      ? "No measurements in this range."
      : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(points[last]!)} on ${result.buckets[last].day}`;
    card.append(title, summary);
    charts.append(card);
    if (last === -1) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "report-canvas";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${label} by day (UTC)`);
    wrapper.append(canvas);
    card.append(wrapper);
    activeCharts.push(new ChartLibrary(canvas, {
      type: "line",
      data: {
        labels: result.buckets.map(({ day }) => day),
        datasets: [{
          label, data: points, spanGaps: false,
          borderColor: "#0c6a69", backgroundColor: "#0c6a69", pointRadius: 3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: { legend: { display: false }, tooltip: { enabled: true } },
        scales: { x: { ticks: { maxTicksLimit: 5 } }, y: { beginAtZero: true, ticks: { precision: digits } } },
      },
    }));
  }
}

function updateButtons(): void {
  lock.disabled = busy;
  range.disabled = busy;
  metricOptions.disabled = busy;
  localOptions.disabled = busy;
  save.disabled = busy;
  exportButton.disabled = busy || !result?.preferences.collectionEnabled || !result.preferences.allowExport;
  clear.disabled = busy || !result?.preferences.allowClearHistory;
}

function display(data: ReportResult): void {
  result = data;
  const preferences = data.preferences;
  range.value = String(data.days);
  for (const option of range.options) option.disabled = Number(option.value) > preferences.retentionDays;
  for (const [key] of entries) input(key).checked = preferences.visibleMetrics.includes(key);
  input("collectionEnabled").checked = preferences.collectionEnabled;
  input("allowExport").checked = preferences.allowExport;
  input("allowClearHistory").checked = preferences.allowClearHistory;
  retention().value = String(preferences.retentionDays);
  note.textContent = preferences.collectionEnabled
    ? "Days use UTC. Usage charts sum reported measurements and leave gaps where measurements are missing."
    : "Report collection is paused. Operational audit records continue to be kept.";
  content.hidden = false;
  renderCharts();
}

async function request(path = "", body?: object): Promise<ReportResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`/api/reports${path}?days=${range.value}`, {
    method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Reports are unavailable.");
  if (data.preferences.collectionEnabled) await chartLibrary();
  return data as ReportResult;
}

async function update(work: () => Promise<ReportResult>, success = ""): Promise<boolean> {
  if (busy) return false;
  busy = true;
  updateButtons();
  status.textContent = "Loading reports…";
  try {
    display(await work());
    status.textContent = success;
    return true;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Reports are unavailable.";
    if (result) range.value = String(result.days);
    return false;
  } finally {
    busy = false;
    updateButtons();
  }
}

if (document.body.dataset.reports === "available") {
  status.textContent = "";
  auth.hidden = false;
}
auth.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const field = auth.elements.namedItem("operatorToken") as HTMLInputElement;
  token = field.value;
  field.value = "";
  if (await update(() => request())) {
    auth.hidden = true;
    lock.hidden = false;
  } else token = "";
});
lock.addEventListener("click", () => {
  token = "";
  result = undefined;
  destroyCharts();
  content.hidden = true;
  lock.hidden = true;
  auth.hidden = false;
  status.textContent = "";
  (auth.elements.namedItem("operatorToken") as HTMLInputElement).focus();
});
range.addEventListener("change", () => { void update(() => request()); });
metricOptions.addEventListener("change", renderCharts);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const body = {
    collectionEnabled: input("collectionEnabled").checked,
    retentionDays: Number(retention().value) as ReportDays,
    visibleMetrics: selectedMetrics(),
    allowExport: input("allowExport").checked,
    allowClearHistory: input("allowClearHistory").checked,
  };
  void update(() => request("/preferences", body), "Report preferences saved.");
});
clear.addEventListener("click", () => {
  if (!confirm("Clear report history? Operational audit records will be kept.")) return;
  void update(() => request("/clear", { confirmed: true }), "Report history cleared.");
});
exportButton.addEventListener("click", () => {
  if (!result?.preferences.allowExport) return;
  const selected = selectedMetrics();
  const buckets = result.buckets.map(({ day, metrics: values }) => ({
    day, metrics: Object.fromEntries(selected.map((metric) => [metric, values[metric]])),
  }));
  const href = URL.createObjectURL(new Blob([JSON.stringify({ days: result.days, buckets }, null, 2)], {
    type: "application/json",
  }));
  const link = document.createElement("a");
  link.href = href;
  link.download = "praxis-report.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
});
