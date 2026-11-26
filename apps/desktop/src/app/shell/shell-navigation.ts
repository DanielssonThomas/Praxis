import type { ShellCommand } from "./shell-command.model";
import type { ShellView } from "./shell-view.model";

export const views = [
  { id: "manager", label: "Manager", short: "m", section: "workspace" },
  { id: "overview", label: "Overview", short: "o", section: "workspace" },
  { id: "kanban", label: "Kanban", short: "k", section: "workspace" },
  { id: "reports", label: "Reports", short: "r", section: "workspace" },
  { id: "setup", label: "Setup", short: "su", section: "configuration" },
  { id: "settings", label: "Settings", short: "s", section: "configuration" },
] as const satisfies readonly ShellView[];

export const managerView = views[0];

const slashCommands = [
  ...views.map((view) => ({
    id: view.id,
    label: view.label,
    short: view.short,
    command: { kind: "navigate", view } as const,
  })),
  { id: "help", label: "Command help", short: "h", command: { kind: "help" } as const },
];

export const commandHelp = slashCommands.map(({ id, short }) => `/${id} (/${short})`).join(" · ");

export function matchSlashCommands(value: string) {
  const query = value.trim().toLowerCase();
  if (!query.startsWith("/") || /\s/.test(query)) return [];
  const prefix = query.slice(1);
  return slashCommands.filter(({ id, short }) => id.startsWith(prefix) || short === prefix);
}

export function resolveCommand(value: string, viewId: string): ShellCommand {
  const command = value.trim().toLowerCase();
  if (command === "") return { kind: "empty" };
  if (!command.startsWith("/") && viewId === managerView.id) {
    return { kind: "manager-prompt", text: value };
  }
  return slashCommands.find(({ id, short }) => command === `/${id}` || command === `/${short}`)?.command
    ?? { kind: "unknown" };
}
