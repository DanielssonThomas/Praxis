import type { RuntimeSessionSnapshot, Usage } from "@praxis/contracts";
import { insertManagerCards } from "./manager-cards.js";
import type { ManagerResource } from "./manager-resources.js";

type ManagerRecord =
  | { kind: "snapshot"; snapshot: RuntimeSessionSnapshot; usage: Usage; resources?: ManagerResource[] }
  | { kind: "error"; message: string };

interface Turn {
  payload: { turnId: string; prompt: string };
  response: HTMLParagraphElement;
}

const endpoint = "/api/manager/turn";
const available = document.body.dataset.manager === "available";
const view = document.querySelector<HTMLElement>('[data-view="manager"]')!;
const form = document.querySelector<HTMLFormElement>("#manager-auth")!;
const tokenField = form.elements.namedItem("operatorToken") as HTMLInputElement;
const open = form.querySelector<HTMLButtonElement>("button")!;
const lock = document.querySelector<HTMLButtonElement>("#manager-lock")!;
const status = document.querySelector<HTMLParagraphElement>("#manager-status")!;
const conversation = document.querySelector<HTMLElement>("#manager-conversation")!;
const transcript = document.querySelector<HTMLOListElement>("#manager-transcript")!;
const usage = document.querySelector<HTMLParagraphElement>("#manager-usage")!;
const reconnect = document.querySelector<HTMLButtonElement>("#manager-reconnect")!;
const settled = new Set(["completed", "failed", "stopped", "interrupted", "unknown"]);
let token: string | undefined;
let active: AbortController | undefined;
let pending: Turn | undefined;

function updateControls(): void {
  form.hidden = !available || token !== undefined;
  lock.hidden = token === undefined;
  conversation.hidden = token === undefined;
  reconnect.hidden = pending === undefined || active !== undefined;
}

function setStatus(value: string): void {
  status.textContent = value;
  status.hidden = value === "";
}

function appendMessage(label: string, text: string): HTMLParagraphElement {
  const message = document.createElement("li");
  message.className = "manager-message";
  const title = document.createElement("strong");
  title.textContent = label;
  const body = document.createElement("p");
  body.textContent = text;
  message.append(title, body);
  transcript.append(message);
  return body;
}

function showSnapshot(turn: Turn, record: Extract<ManagerRecord, { kind: "snapshot" }>): void {
  const { output, status: nativeStatus } = record.snapshot;
  const nearBottom = view.scrollHeight - view.clientHeight - view.scrollTop < 100;
  if (output.availability === "available") {
    turn.response.textContent = output.truncated ? `Earlier output omitted.\n${output.text}` : output.text;
  }
  if (record.resources) insertManagerCards(turn.response, record.resources);
  if (record.usage.metering === "reported") {
    const { inputTokens, outputTokens } = record.usage;
    const counts = [
      inputTokens === undefined ? "" : `${inputTokens.toLocaleString()} input`,
      outputTokens === undefined ? "" : `${outputTokens.toLocaleString()} output`,
    ].filter(Boolean).join(" · ");
    usage.textContent = counts ? `Turn usage: ${counts} tokens` : "";
    usage.hidden = !counts;
  } else {
    usage.hidden = true;
  }
  if (nearBottom && !view.hidden) view.scrollTop = view.scrollHeight;
  if (!settled.has(nativeStatus)) return;
  pending = undefined;
  if (nativeStatus === "completed") {
    if (output.availability === "unavailable" && !turn.response.textContent) turn.response.textContent = output.reason;
    setStatus("");
  } else {
    setStatus(`Hermes reported the turn as ${nativeStatus}.`);
  }
}

async function streamTurn(turn: Turn, credential: string): Promise<void> {
  const connection = new AbortController();
  active = connection;
  setStatus("Waiting for the manager…");
  updateControls();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify(turn.payload),
      signal: connection.signal,
    });
    if (!response.ok || response.body === null) {
      if (response.status === 401 || response.status === 403) {
        token = undefined;
        setStatus("The operator token was refused.");
      } else if (response.status === 400 || response.status === 409) {
        pending = undefined;
        turn.response.textContent = "The manager could not accept this turn.";
        setStatus("");
      } else {
        setStatus("The manager connection is unavailable.");
      }
      return;
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      let buffer = "";
      while (!connection.signal.aborted) {
        const { done, value } = await reader.read();
        if (done || connection.signal.aborted) break;
        const lines = (buffer + value).split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const record = JSON.parse(line) as ManagerRecord;
          if (record.kind === "error") throw new Error(record.message);
          if (record.kind !== "snapshot") throw new Error("Unexpected manager response.");
          setStatus("Receiving manager output…");
          showSnapshot(turn, record);
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (pending === turn && !connection.signal.aborted) setStatus("The stream was interrupted. Reconnect to continue.");
  } catch {
    if (!connection.signal.aborted) setStatus("The stream was interrupted. Reconnect to continue.");
  } finally {
    if (active === connection) active = undefined;
    updateControls();
  }
}

export function submitManagerPrompt(prompt: string): string | undefined {
  if (!available) return "Configure the local Hermes manager connection.";
  if (!token) return "Open the manager with the operator token before sending.";
  if (pending) return active ? "Wait for the current turn." : "Reconnect to continue the current turn.";

  appendMessage("You", prompt);
  pending = { payload: { turnId: crypto.randomUUID(), prompt }, response: appendMessage("Manager", "") };
  usage.hidden = true;
  if (!view.hidden) view.scrollTop = view.scrollHeight;
  void streamTurn(pending, token);
}

async function authenticate(credential: string): Promise<void> {
  open.disabled = true;
  try {
    const response = await fetch(endpoint, { method: "HEAD", headers: { Authorization: `Bearer ${credential}` } });
    if (response.status !== 204) {
      setStatus(response.status === 401 || response.status === 403
        ? "The operator token was refused." : "The manager connection is unavailable.");
      return;
    }
    token = credential;
    setStatus(pending ? "Reconnect to continue the current turn." : "");
  } catch {
    setStatus("The manager connection is unavailable.");
  } finally {
    open.disabled = false;
    updateControls();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (open.disabled) return;
  const credential = tokenField.value.trim();
  tokenField.value = "";
  if (credential) void authenticate(credential);
});
lock.addEventListener("click", () => {
  active?.abort();
  active = undefined;
  token = undefined;
  setStatus("Manager locked.");
  updateControls();
  tokenField.focus();
});
reconnect.addEventListener("click", () => {
  if (token && pending && !active) void streamTurn(pending, token);
});

if (available) setStatus("");
updateControls();
