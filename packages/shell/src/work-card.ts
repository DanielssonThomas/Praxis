import type { RuntimeSessionStatus, Task } from "@praxis/contracts";

export function taskCard(task: Task): HTMLElement {
  const card = document.createElement("article");
  card.className = "kanban-card";
  card.setAttribute("aria-label", task.title);
  const heading = document.createElement("h3");
  heading.textContent = task.title;
  card.append(heading);
  return card;
}

export function workerStatus(status?: RuntimeSessionStatus): string {
  return status === undefined ? "Unavailable" : status.replaceAll("_", " ");
}
