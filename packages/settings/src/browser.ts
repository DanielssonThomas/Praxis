import type { Settings } from "./index.js";

const form = document.querySelector<HTMLFormElement>("#settings")!;
const fields = document.querySelector<HTMLFieldSetElement>("#fields")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
const runtime = document.querySelector<HTMLSelectElement>("#worker-runtime")!;

function input(name: string): HTMLInputElement {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement)) throw new Error(`Missing settings field ${name}`);
  return field;
}

function fill(value: Settings): void {
  input("axiomEnabled").checked = value.policy.axiomEnabled;
  input("profiles").value = value.policy.profiles.join(", ");
  input("managerProfile").value = value.manager.profile;
  input("managerModel").value = value.manager.model ?? "";
  runtime.value = value.worker.runtime;
  input("workerModel").value = value.worker.model ?? "";
  input("maxTaskTokens").value = value.budgets.maxTaskTokens?.toString() ?? "";
  input("maxTaskUsd").value = value.budgets.maxTaskUsd?.toString() ?? "";
  input("memoryEnabled").checked = value.memory.enabled;
  input("autoPresent").checked = value.display.autoPresent;
}

function optionalNumber(name: string): number | null {
  const field = input(name);
  return field.value === "" ? null : field.valueAsNumber;
}

function readForm(): Settings {
  return {
    schemaVersion: 1,
    policy: {
      axiomEnabled: input("axiomEnabled").checked,
      profiles: input("profiles").value.split(",").map((value) => value.trim()).filter(Boolean),
    },
    manager: {
      runtime: "hermes",
      profile: input("managerProfile").value.trim(),
      model: input("managerModel").value.trim() || null,
    },
    worker: {
      runtime: runtime.value as Settings["worker"]["runtime"],
      model: input("workerModel").value.trim() || null,
    },
    budgets: { maxTaskTokens: optionalNumber("maxTaskTokens"), maxTaskUsd: optionalNumber("maxTaskUsd") },
    memory: { enabled: input("memoryEnabled").checked },
    display: { autoPresent: input("autoPresent").checked },
  };
}

async function request(options?: RequestInit): Promise<Settings> {
  const response = await fetch("/api/settings", options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body as Settings;
}

function show(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle("error", error);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = readForm();
  fields.disabled = true;
  show("Saving settings…");
  try {
    fill(await request({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }));
    show("Settings saved.");
  } catch (error) {
    show(error instanceof Error ? error.message : "Settings could not be saved.", true);
  } finally {
    fields.disabled = false;
  }
});

try {
  fill(await request());
  fields.disabled = false;
  show("");
} catch (error) {
  show(error instanceof Error ? error.message : "Settings could not be loaded.", true);
}
