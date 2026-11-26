import type { KanbanIssueTarget, KanbanTask } from "../../../generated/desktop-ipc";

export type KanbanStage = "loading" | "setup" | "locked" | "ready" | "unavailable";

export interface KanbanColumn {
  status: string;
  tasks: KanbanTask[];
}

export function groupByNativeStatus(tasks: KanbanTask[]): KanbanColumn[] {
  const byStatus = new Map<string, KanbanTask[]>();
  for (const task of tasks) {
    const column = byStatus.get(task.status);
    if (column) column.push(task);
    else byStatus.set(task.status, [task]);
  }
  return Array.from(byStatus, ([status, grouped]) => ({ status, tasks: grouped }));
}

export function parseIssueTarget(nativeId: string, text: string): KanbanIssueTarget | undefined {
  const match = /^(\S+\/\S+)#([1-9][0-9]*)$/.exec(text.trim());
  if (!match) return;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return;
  return { nativeId, repository: match[1], number };
}
