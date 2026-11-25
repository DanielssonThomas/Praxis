import type { ManagerResource } from "./manager-resources.js";
import { taskCard, workerStatus } from "./work-card.js";

function statusCard(title: string, text?: string): HTMLElement {
  const card = document.createElement("article");
  card.className = "session-pane";
  card.setAttribute("aria-label", title);
  const heading = document.createElement("h3");
  heading.textContent = title;
  card.append(heading);
  if (text !== undefined) {
    const body = document.createElement("p");
    body.textContent = text;
    card.append(body);
  }
  return card;
}

function details(...values: string[]): HTMLDetailsElement {
  const block = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Details";
  block.append(summary);
  for (const value of values) {
    const body = document.createElement("p");
    body.textContent = value;
    block.append(body);
  }
  return block;
}

export function insertManagerCards(message: HTMLParagraphElement, resources: ManagerResource[]): void {
  if (resources.length === 0) return;
  const deck = document.createElement("aside");
  deck.className = "manager-cards";
  deck.setAttribute("aria-label", "Related work");
  for (const resource of resources) {
    let card: HTMLElement;
    if (resource.kind === "task") {
      card = taskCard(resource.task);
      card.append(details(resource.task.id));
    } else if (resource.kind === "session") {
      card = statusCard("Worker session", workerStatus(resource.status));
      card.append(details(resource.session.id, `Task ${resource.session.taskId}`));
    } else {
      card = statusCard(resource.resource === "task" ? "Task unavailable" : "Worker session unavailable");
    }
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      card.remove();
      if (!deck.hasChildNodes()) deck.remove();
    });
    card.append(dismiss);
    deck.append(card);
  }
  message.after(deck);
}
