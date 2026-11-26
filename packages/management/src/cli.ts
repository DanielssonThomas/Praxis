import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { mcpAuthoritySchema } from "@praxis/mcp";
import { OperationalStore } from "@praxis/state";
import { ManagementService } from "./index.js";

async function main(): Promise<void> {
  const [command = "run", file] = process.argv.slice(2);
  const authority = process.env.PRAXIS_MCP_CONFIG_FILE;
  if (!authority) throw new Error("Supply the local MCP authority file.");
  const load = async () => mcpAuthoritySchema.parse(JSON.parse(await readFile(authority, "utf8")));
  const database = resolve((await load()).database);
  const store = new OperationalStore(database);
  try {
    if (command === "list") {
      console.log(JSON.stringify(store.management.list(), null, 2));
      return;
    }
    if (command === "usage") {
      console.log(JSON.stringify(store.eventsOfKind("management.usage").flatMap(({ subject }) =>
        subject.kind === "usage" ? [store.getUsage(subject.id)] : []), null, 2));
      return;
    }

    const rawProfile = process.env.PRAXIS_BACKGROUND_HERMES_ORIGIN;
    const apiKey = process.env.PRAXIS_BACKGROUND_HERMES_API_KEY;
    const principalId = process.env.PRAXIS_BACKGROUND_PRINCIPAL_ID;
    if (!rawProfile || !apiKey || !principalId) throw new Error("Configure the dedicated background manager profile and MCP principal.");
    const runtime = new HermesRuntime({ origin: rawProfile, apiKey });
    const profile = rawProfile.replace(/\/$/, "");
    if (!/\/p\/[a-z0-9][a-z0-9_-]*$/.test(profile) || profile.endsWith("/p/default")
      || profile === process.env.PRAXIS_HERMES_ORIGIN?.replace(/\/$/, "")) {
      throw new Error("Use a distinct named Hermes profile for background management.");
    }
    const service = new ManagementService({
      store, runtime, profile, principalId,
      concurrency: Number(process.env.PRAXIS_BACKGROUND_CONCURRENCY ?? 2),
      maxAttempts: Number(process.env.PRAXIS_BACKGROUND_MAX_ATTEMPTS ?? 3),
      loadGrant: async () => {
        const config = await load();
        if (resolve(config.database) !== database) throw new Error("The background authority database changed.");
        if (config.skills?.curatorPrincipalId === principalId) {
          throw new Error("Background coordination requires its configured read-only MCP principal.");
        }
        const grant = config.grants.find((entry) => entry.principalId === principalId);
        if (grant === undefined) throw new Error("The configured background principal is unavailable.");
        return grant;
      },
    });
    if (command === "enqueue" && file) {
      console.log(await service.enqueue(JSON.parse(await readFile(file, "utf8"))));
      return;
    }
    if (command !== "run") throw new Error("Use run, enqueue FILE, list, or usage.");
    const stop = new AbortController();
    process.once("SIGINT", () => stop.abort());
    process.once("SIGTERM", () => stop.abort());
    while (!stop.signal.aborted) {
      try {
        await service.advance();
      } catch {
        console.error("The background management pass could not read scope or save its checkpoint.");
      }
      await delay(1_000, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    store.close();
  }
}

void main().catch(() => {
  console.error("Background management is unavailable. Check its local configuration and command.");
  process.exitCode = 1;
});
