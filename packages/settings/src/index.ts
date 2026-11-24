import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

const identifier = z.string().max(80).regex(
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
  "Use lowercase letters and digits separated by dots, underscores or hyphens.",
);
const model = z.string().max(120).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
  "Enter a model identifier using letters, digits, dots, underscores, colons, slashes or hyphens.",
).nullable();
const workerRuntimes = ["codex", "claude", "hermes"] as const;

export const settingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  policy: z.strictObject({
    axiomEnabled: z.boolean(),
    profiles: z.array(identifier).max(20),
  }),
  manager: z.strictObject({
    runtime: z.literal("hermes"),
    profile: identifier,
    model,
  }),
  worker: z.strictObject({ runtime: z.enum(workerRuntimes), model }),
  budgets: z.strictObject({
    maxTaskTokens: z.int().positive().nullable(),
    maxTaskUsd: z.number().nonnegative().nullable(),
  }),
  memory: z.strictObject({ enabled: z.boolean() }),
  display: z.strictObject({ autoPresent: z.boolean() }),
});
export type Settings = z.infer<typeof settingsSchema>;

export class SettingsError extends Error {
  constructor(
    readonly code: "invalid_settings" | "read_failed" | "write_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SettingsError";
  }
}

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    policy: { axiomEnabled: true, profiles: [] },
    manager: { runtime: "hermes", profile: "praxis-manager", model: null },
    worker: { runtime: "codex", model: null },
    budgets: { maxTaskTokens: null, maxTaskUsd: null },
    memory: { enabled: true },
    display: { autoPresent: true },
  };
}

export function settingsPath(): string {
  const configDirectory = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return process.env.PRAXIS_CONFIG_FILE || join(configDirectory, "praxis", "settings.json");
}

function validate(value: unknown): Settings {
  const parsed = settingsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map(({ path, message }) => `${path.join(".") || "settings"} — ${message}`);
  throw new SettingsError("invalid_settings", problems.join("\n"));
}

export async function readSettings(path: string): Promise<Settings> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return defaultSettings();
    throw new SettingsError("read_failed", "Could not read settings. Check the file and its permissions.", { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new SettingsError("invalid_settings", "Settings must contain valid JSON. Correct the file and reload.", { cause: error });
  }
  return validate(value);
}

export async function saveSettings(path: string, value: unknown): Promise<Settings> {
  const settings = validate(value);
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new SettingsError("write_failed", "Could not save settings. Check the file and directory permissions.", { cause: error });
  }
  return settings;
}
