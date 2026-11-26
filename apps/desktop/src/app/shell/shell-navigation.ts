import type { ShellCommand } from "./shell-command.model";
import type { ShellView } from "./shell-view.model";

export const views = [
  { id: "manager", label: "Manager", short: "m" },
  { id: "overview", label: "Overview", short: "o" },
  { id: "kanban", label: "Kanban", short: "k" },
  { id: "reports", label: "Reports", short: "r" },
  { id: "settings", label: "Settings", short: "s" },
] as const satisfies readonly ShellView[];

export const managerView = views[0];

export const commandHelp = [
  ...views.map(({ id, short }) => `/${id} (/${short})`),
  "/help (/h)",
].join(" · ");

export function resolveCommand(value: string, viewId: string): ShellCommand {
  const command = value.trim().toLowerCase();
  if (command === "") return { kind: "empty" };
  if (!command.startsWith("/") && viewId === managerView.id) {
    return { kind: "manager-prompt", text: value };
  }
  if (command === "/help" || command === "/h") return { kind: "help" };

  const view = views.find(({ id, short }) => command === `/${id}` || command === `/${short}`);
  return view ? { kind: "navigate", view } : { kind: "unknown" };
}
