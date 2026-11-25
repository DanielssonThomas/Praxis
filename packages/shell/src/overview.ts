import type { OverviewPane, OverviewProjection } from "./overview-server.js";
import type { SessionControlView } from "./session-control.js";
import { workerStatus } from "./work-card.js";

const view = document.querySelector<HTMLElement>('[data-view="overview"]')!;
const auth = document.querySelector<HTMLFormElement>("#overview-auth")!;
const tokenField = auth.elements.namedItem("operatorToken") as HTMLInputElement;
const lock = document.querySelector<HTMLButtonElement>("#overview-lock")!;
const status = document.querySelector<HTMLParagraphElement>("#overview-status")!;
const association = document.querySelector<HTMLParagraphElement>("#overview-association")!;
const grid = document.querySelector<HTMLElement>("#overview-grid")!;

type PaneId = OverviewPane["session"]["id"];
interface PaneElements {
  card: HTMLElement;
  title: HTMLHeadingElement;
  ticket: HTMLParagraphElement;
  status: HTMLParagraphElement;
  focus: HTMLParagraphElement;
  output: HTMLPreElement;
  expansion: HTMLDivElement;
  details: HTMLParagraphElement;
  controls: PaneControls;
  button: HTMLButtonElement;
}
interface PaneControls {
  mode: HTMLParagraphElement;
  feedback: HTMLParagraphElement;
  take: HTMLButtonElement;
  return: HTMLButtonElement;
  form: HTMLFormElement;
  text: HTMLTextAreaElement;
  send: HTMLButtonElement;
  busy: boolean;
  view?: SessionControlView;
}
const panes = new Map<PaneId, PaneElements>();
let expanded: PaneId | undefined;
let token: string | undefined;
let loading = false;

function feedback(text: string): void {
  status.textContent = text;
  status.hidden = text === "";
}

async function read(credential: string): Promise<OverviewProjection> {
  const response = await fetch("/api/overview", { headers: { Authorization: `Bearer ${credential}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Overview is unavailable.");
  return data as OverviewProjection;
}

function setExpansion(): void {
  for (const [id, pane] of panes) {
    const open = id === expanded;
    pane.card.dataset.expanded = String(open);
    pane.button.setAttribute("aria-expanded", String(open));
    pane.button.textContent = open ? "Collapse" : "Expand";
    pane.expansion.hidden = !open;
  }
}

function makePane(id: PaneId): PaneElements {
  const card = document.createElement("article");
  card.className = "session-pane";
  card.dataset.sessionId = id;
  card.setAttribute("aria-labelledby", `title-${id}`);
  const top = document.createElement("div");
  top.className = "pane-top";
  const title = document.createElement("h2");
  title.id = `title-${id}`;
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-controls", `details-${id}`);
  button.addEventListener("click", () => {
    expanded = expanded === id ? undefined : id;
    setExpansion();
  });
  top.append(title, button);
  const ticket = document.createElement("p");
  const status = document.createElement("p");
  const focus = document.createElement("p");
  focus.textContent = "Manager activity";
  const output = document.createElement("pre");
  output.tabIndex = 0;
  output.setAttribute("aria-label", "Session output");
  const details = document.createElement("p");
  const expansion = document.createElement("div");
  expansion.id = `details-${id}`;
  const controls = makeControls(id, expansion);
  expansion.prepend(details);
  card.append(top, ticket, status, focus, output, expansion);
  grid.append(card);
  return { card, title, ticket, status, focus, output, expansion, details, controls, button };
}

function makeControls(id: PaneId, parent: HTMLElement): PaneControls {
  const panel = document.createElement("div");
  panel.className = "pane-controls";
  const mode = document.createElement("p");
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  const take = document.createElement("button");
  take.textContent = "Take over";
  const handback = document.createElement("button");
  handback.textContent = "Return control";
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = "Manual guidance";
  const text = document.createElement("textarea");
  text.required = true;
  text.maxLength = 1_000;
  text.rows = 2;
  label.append(text);
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Send guidance";
  form.append(label, send);
  panel.append(mode, take, form, handback, message);
  parent.append(panel);
  const controls = { mode, feedback: message, take, return: handback, form, text, send, busy: false };
  take.addEventListener("click", () => { void controlAction(id, controls, "takeover"); });
  handback.addEventListener("click", () => { void controlAction(id, controls, "return"); });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void controlAction(id, controls, "guide");
  });
  return controls;
}

function displayControls(controls: PaneControls, state: SessionControlView): void {
  controls.view = state;
  let message: string;
  if (state.mode === "automated_write") message = "Read-only inspection. A scoped action holds native control.";
  else if (state.mode === "read_only") message = "Read-only inspection";
  else if (state.guidance === "pending") message = "Manual control. Waiting for Hermes to record guidance.";
  else if (state.guidance === "uncertain") message = "Manual control. Guidance needs verification in Hermes.";
  else message = "Manual control";
  controls.mode.textContent = message;
  controls.take.hidden = !state.canTakeover;
  controls.return.hidden = !state.canReturn;
  controls.form.hidden = !state.canGuide;
  controls.take.disabled = controls.return.disabled = controls.send.disabled = controls.busy;
  controls.text.disabled = controls.busy;
}

async function controlAction(id: PaneId, controls: PaneControls, operation: "takeover" | "guide" | "return"): Promise<void> {
  const credential = token;
  if (credential === undefined || controls.busy || controls.view === undefined) return;
  controls.busy = true;
  displayControls(controls, controls.view);
  controls.feedback.textContent = "";
  try {
    const body = operation === "guide" ? { operation, sessionId: id, text: controls.text.value } : { operation, sessionId: id };
    const response = await fetch("/api/overview/control", {
      method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Session control is unavailable.");
    if (credential !== token) return;
    const state = data as SessionControlView;
    displayControls(controls, state);
    if (operation === "guide") {
      controls.text.value = "";
      controls.feedback.textContent = "Hermes accepted this guidance for delivery.";
    }
    if (operation === "return") {
      controls.feedback.textContent = state.guidance === "delivered"
        ? "Control returned. Hermes delivered the guidance at a tool boundary."
        : state.guidance === "recorded"
          ? "Control returned. Hermes recorded the guidance in the transcript."
          : "Control returned.";
    }
  } catch (error) {
    if (credential === token) {
      controls.feedback.textContent = error instanceof Error ? error.message : "Session control is unavailable.";
    }
  } finally {
    controls.busy = false;
    if (credential === token && controls.view !== undefined) displayControls(controls, controls.view);
  }
}

function detailsFor(pane: OverviewPane): string {
  if (pane.runtime.availability === "unavailable") return `${pane.session.id} · Usage unavailable`;
  const { usage } = pane.runtime;
  if (usage.metering === "unknown") return `${pane.session.id} · ${usage.reason}`;
  const measurements: string[] = [];
  if (usage.inputTokens !== undefined) measurements.push(`Input tokens ${usage.inputTokens.toLocaleString()}`);
  if (usage.outputTokens !== undefined) measurements.push(`Output tokens ${usage.outputTokens.toLocaleString()}`);
  if (usage.cost !== undefined) measurements.push(`Cost ${usage.cost.amount} ${usage.cost.currency}`);
  return [pane.session.id, ...measurements].join(" · ");
}

function render(projection: OverviewProjection): void {
  const current = new Set(projection.panes.map(({ session }) => session.id));
  for (const [id, pane] of panes) {
    if (!current.has(id)) {
      pane.card.remove();
      panes.delete(id);
      if (expanded === id) expanded = undefined;
    }
  }
  for (const pane of projection.panes) {
    const elements = panes.get(pane.session.id) ?? makePane(pane.session.id);
    panes.set(pane.session.id, elements);
    elements.title.textContent = pane.task.title;
    elements.ticket.textContent = pane.ticket;
    elements.card.dataset.highlighted = String(pane.highlighted);
    elements.focus.hidden = !pane.highlighted;
    const observed = pane.runtime;
    elements.status.textContent = workerStatus(observed.availability === "available" ? observed.snapshot.status : undefined);
    let text: string;
    if (observed.availability === "unavailable") text = observed.reason;
    else if (observed.snapshot.output.availability === "unavailable") text = observed.snapshot.output.reason;
    else text = `${observed.snapshot.output.truncated ? "Earlier output omitted\n" : ""}${observed.snapshot.output.text}`;
    if (elements.output.textContent !== text) {
      const scroll = elements.output.scrollTop;
      const stick = elements.output.scrollHeight - scroll - elements.output.clientHeight < 16;
      elements.output.textContent = text;
      elements.output.scrollTop = stick ? elements.output.scrollHeight : scroll;
    }
    elements.details.textContent = [detailsFor(pane), pane.usageNotice].filter(Boolean).join(" · ");
    if (!elements.controls.busy) displayControls(elements.controls, pane.control);
  }
  setExpansion();
  association.hidden = projection.association.available;
  association.textContent = projection.association.available ? "" : projection.association.reason;
  grid.hidden = projection.panes.length === 0;
  feedback(projection.panes.length === 0 ? "No native session assignments are registered." : "");
}

auth.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (loading) return;
  loading = true;
  const credential = tokenField.value.trim();
  tokenField.value = "";
  try {
    render(await read(credential));
    token = credential;
    lock.hidden = false;
    auth.hidden = true;
  } catch (error) {
    feedback(error instanceof Error ? error.message : "Overview could not be opened.");
  } finally {
    loading = false;
  }
});

lock.addEventListener("click", () => {
  token = undefined;
  expanded = undefined;
  panes.clear();
  grid.replaceChildren();
  grid.hidden = true;
  lock.hidden = true;
  association.hidden = true;
  auth.hidden = false;
  feedback("");
});

if (document.body.dataset.overview === "available") {
  auth.hidden = false;
  feedback("");
  window.setInterval(async () => {
    const credential = token;
    if (credential === undefined || view.hidden || loading) return;
    loading = true;
    try {
      const projection = await read(credential);
      if (credential === token) render(projection);
    } catch (error) {
      if (credential === token) feedback(error instanceof Error ? error.message : "Overview is unavailable.");
    } finally {
      loading = false;
    }
  }, 900);
}
