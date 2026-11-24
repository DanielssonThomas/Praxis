import type { ApprovalActivity } from "@praxis/approvals";

const toggle = document.querySelector<HTMLButtonElement>("#activity-toggle")!;
const panel = document.querySelector<HTMLElement>("#activity-panel")!;
const authentication = document.querySelector<HTMLFormElement>("#activity-auth")!;
const tokenField = authentication.elements.namedItem("operatorToken") as HTMLInputElement;
const lock = document.querySelector<HTMLButtonElement>("#activity-lock")!;
const list = document.querySelector<HTMLElement>("#activity-list")!;
const message = document.querySelector<HTMLParagraphElement>("#activity-message")!;
const cards = new Map<ApprovalActivity["requestId"], { card: HTMLElement; snapshot: string }>();
let token: string | undefined;
let busy = false;
let polling = false;
let revision = 0;

const labels: Record<ApprovalActivity["state"], string> = {
  processing: "Processing",
  attention: "Needs attention",
  resolved: "Decision resolved",
  denied: "Denied",
  expired: "Expired",
  invalidated: "Invalidated",
  refused: "Refused",
  uncertain: "Execution unverified",
};

function feedback(text: string): void {
  message.hidden = text === "";
  message.textContent = text;
}

async function request<T>(credential: string, path = "", body?: object): Promise<T> {
  const result = await fetch(`/api/activity${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await result.json();
  if (!result.ok) throw new Error(data.error ?? "Activity is unavailable.");
  return data as T;
}

function addText(container: HTMLElement, tag: "h3" | "p", text: string, className?: string) {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  element.textContent = text;
  container.append(element);
}

function button(container: HTMLElement, label: string, action: () => void) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.addEventListener("click", action);
  container.append(element);
}

function upsert(item: ApprovalActivity): void {
  const snapshot = JSON.stringify(item);
  const existing = cards.get(item.requestId);
  if (existing?.snapshot === snapshot) return;
  const card = existing?.card ?? document.createElement("article");
  card.className = "activity-card";
  card.dataset.requestId = item.requestId;
  card.dataset.state = item.state;
  card.replaceChildren();

  const name = item.action.kind === "session.stop" ? "Stop worker" : item.action.kind === "session.inspect"
    ? "Inspect worker" : item.action.kind;
  addText(card, "h3", `${name} · ${item.action.target.id}`);
  addText(card, "p", labels[item.state], "activity-state");
  addText(card, "p", `Requested by ${item.actorId}`, "activity-action-text");

  const actions = document.createElement("div");
  actions.className = "activity-actions";
  if (item.state === "processing") {
    button(actions, "Inspect", () => void operate("/inspect", { requestId: item.requestId }));
  } else if (item.state === "attention") {
    addText(card, "p", `Approval expires ${new Date(item.expiresAt).toLocaleTimeString()}.`, "activity-action-text");
    button(actions, "Approve once", () => {
      void operate("/decision", { requestId: item.requestId, approvalId: item.approval.id, decision: "approve" });
    });
    button(actions, "Deny", () => {
      void operate("/decision", { requestId: item.requestId, approvalId: item.approval.id, decision: "deny" });
    });
  } else if (item.state === "resolved") {
    const native = item.native.status === "stopping"
      ? "Stop requested. Hermes has yet to report a settled stop."
      : `Hermes reported the run as ${item.native.status.replaceAll("_", " ")}.`;
    addText(card, "p", native, "activity-action-text");
  } else if ("reason" in item) {
    addText(card, "p", item.reason, "activity-action-text");
  }
  if (actions.childElementCount > 0) card.append(actions);
  cards.set(item.requestId, { card, snapshot });
  if (existing === undefined) list.append(card);
}

function render(items: ApprovalActivity[]): void {
  const present = new Set(items.map(({ requestId }) => requestId));
  for (const [requestId, { card }] of cards) {
    if (!present.has(requestId)) {
      card.remove();
      cards.delete(requestId);
    }
  }
  for (const item of items) upsert(item);
}

async function operate(path: string, body: object): Promise<void> {
  if (busy || token === undefined) return;
  const credential = token;
  busy = true;
  revision += 1;
  try {
    const item = await request<ApprovalActivity>(credential, path, body);
    if (credential === token) {
      upsert(item);
      feedback("");
    }
  } catch (error) {
    if (credential !== token) return;
    feedback(error instanceof Error ? error.message : "The activity request failed.");
    try {
      const items = await request<ApprovalActivity[]>(credential);
      if (credential === token) render(items);
    } catch {
      // The previous action error remains visible when refresh is unavailable.
    }
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
    render(await request<ApprovalActivity[]>(credential));
    token = credential;
    authentication.hidden = true;
    lock.hidden = false;
    feedback(cards.size === 0 ? "No activity." : "");
  } catch (error) {
    feedback(error instanceof Error ? error.message : "Activity could not be opened.");
  } finally {
    busy = false;
  }
});

lock.addEventListener("click", () => {
  token = undefined;
  authentication.hidden = false;
  lock.hidden = true;
  render([]);
  feedback("");
});

toggle.addEventListener("click", () => {
  panel.hidden = !panel.hidden;
  toggle.setAttribute("aria-expanded", String(!panel.hidden));
});

if (document.body.dataset.activity === "available") {
  toggle.hidden = false;
  window.setInterval(async () => {
    const credential = token;
    const snapshot = revision;
    if (credential === undefined || panel.hidden || busy || polling) return;
    polling = true;
    try {
      const items = await request<ApprovalActivity[]>(credential);
      if (credential === token && snapshot === revision) {
        render(items);
        if (items.length > 0 && message.textContent === "No activity.") feedback("");
      }
    } catch (error) {
      if (credential === token && snapshot === revision) {
        feedback(error instanceof Error ? error.message : "Activity is unavailable.");
      }
    } finally {
      polling = false;
    }
  }, 2_000);
}
