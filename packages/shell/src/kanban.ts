import type { KanbanProjection, KanbanTask } from "@praxis/kanban";

const authentication = document.querySelector<HTMLFormElement>("#kanban-auth")!;
const tokenField = authentication.elements.namedItem("operatorToken") as HTMLInputElement;
const refresh = document.querySelector<HTMLButtonElement>("#kanban-refresh")!;
const lock = document.querySelector<HTMLButtonElement>("#kanban-lock")!;
const status = document.querySelector<HTMLParagraphElement>("#kanban-status")!;
const provider = document.querySelector<HTMLParagraphElement>("#kanban-provider")!;
const columns = document.querySelector<HTMLElement>("#kanban-columns")!;
let token: string | undefined;
let busy = false;

async function request<T>(credential: string, path = "", body?: object): Promise<T> {
  const response = await fetch(`/api/kanban${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The Kanban board is unavailable.");
  return data as T;
}

function feedback(message: string): void {
  status.textContent = message;
  status.hidden = message === "";
}

function cardFor(task: KanbanTask, linking: boolean): HTMLElement {
  const card = document.createElement("article");
  card.className = "kanban-card";
  card.dataset.nativeId = task.nativeId;
  const heading = document.createElement("h3");
  heading.textContent = task.task.title;
  const assignee = document.createElement("p");
  assignee.textContent = task.assignee === null ? task.nativeId : `${task.nativeId} · ${task.assignee}`;
  card.append(heading, assignee);

  if (task.links.length > 0) {
    const links = document.createElement("ul");
    for (const { repository, number } of task.links) {
      const item = document.createElement("li");
      const anchor = document.createElement("a");
      anchor.href = `https://github.com/${repository}/issues/${number}`;
      anchor.rel = "noopener noreferrer";
      anchor.target = "_blank";
      anchor.textContent = `${repository}#${number}`;
      item.append(anchor);
      links.append(item);
    }
    card.append(links);
  }

  if (linking && task.status !== "archived") {
    const form = document.createElement("form");
    form.setAttribute("aria-label", `Link a GitHub issue to ${task.task.title}`);
    const label = document.createElement("label");
    label.textContent = "GitHub issue";
    const input = document.createElement("input");
    input.placeholder = "owner/repo#42";
    input.required = true;
    label.append(input);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Link issue";
    form.append(label, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void link(task.nativeId, input.value.trim());
    });
    card.append(form);
  }
  return card;
}

function render(board: KanbanProjection): void {
  const grouped = new Map<string, KanbanTask[]>();
  for (const task of board.tasks) {
    const group = grouped.get(task.status) ?? [];
    group.push(task);
    grouped.set(task.status, group);
  }
  columns.replaceChildren();
  provider.hidden = board.provider.available;
  provider.textContent = board.provider.available ? "" : board.provider.reason;
  for (const [state, tasks] of grouped) {
    const column = document.createElement("section");
    column.className = "kanban-column";
    column.dataset.status = state;
    const heading = document.createElement("h2");
    heading.textContent = state.replaceAll("_", " ");
    column.append(heading, ...tasks.map((task) => cardFor(task, board.provider.available)));
    columns.append(column);
  }
  feedback(board.tasks.length === 0 ? "No tasks on the selected Hermes board." : "");
}

async function link(nativeId: string, text: string): Promise<void> {
  if (token === undefined || busy) return;
  const selected = /^(\S+)#([1-9][0-9]*)$/.exec(text);
  if (selected === null) {
    feedback("Enter a GitHub issue as owner/repo#42.");
    return;
  }
  const credential = token;
  busy = true;
  try {
    await request(credential, "/link", { nativeId, repository: selected[1], number: Number(selected[2]) });
    const board = await request<KanbanProjection>(credential);
    if (credential === token) render(board);
  } catch (error) {
    if (credential === token) feedback(error instanceof Error ? error.message : "The issue link could not be saved.");
  } finally {
    busy = false;
  }
}

authentication.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const credential = tokenField.value.trim();
  tokenField.value = "";
  try {
    render(await request<KanbanProjection>(credential));
    token = credential;
    refresh.hidden = false;
    lock.hidden = false;
    authentication.hidden = true;
  } catch (error) {
    feedback(error instanceof Error ? error.message : "The Kanban board could not be opened.");
  } finally {
    busy = false;
  }
});

refresh.addEventListener("click", async () => {
  const credential = token;
  if (credential === undefined || busy) return;
  busy = true;
  try {
    const board = await request<KanbanProjection>(credential);
    if (credential === token) render(board);
  } catch (error) {
    if (credential === token) feedback(error instanceof Error ? error.message : "The board could not be refreshed.");
  } finally {
    busy = false;
  }
});

lock.addEventListener("click", () => {
  token = undefined;
  refresh.hidden = true;
  lock.hidden = true;
  provider.hidden = true;
  columns.replaceChildren();
  authentication.hidden = false;
  feedback("");
});

if (document.body.dataset.kanban === "available") {
  authentication.hidden = false;
  feedback("");
}
