import type { Routes } from "@angular/router";
import { ManagerTemplate } from "../features/manager";
import { OverviewTemplate } from "../features/overview";
import { KanbanTemplate } from "../features/kanban";
import { ReportsTemplate } from "../features/reports";
import { SetupTemplate } from "../features/setup";
import { SettingsTemplate } from "../features/settings";
import { managerView, views } from "./shell-navigation";

const pages = {
  manager: ManagerTemplate,
  overview: OverviewTemplate,
  kanban: KanbanTemplate,
  reports: ReportsTemplate,
  setup: SetupTemplate,
  settings: SettingsTemplate,
};

export const routes: Routes = [
  ...views.map(({ id, label }) => ({ path: id, component: pages[id], title: `${label} — Praxis` })),
  { path: "", pathMatch: "full", redirectTo: managerView.id },
  { path: "**", redirectTo: managerView.id },
];
