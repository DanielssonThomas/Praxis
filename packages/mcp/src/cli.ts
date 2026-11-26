import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { readSettings, settingsPath } from "@praxis/settings";
import { OperationalStore } from "@praxis/state";
import { createPraxisMcpServer, mcpAuthoritySchema } from "./index.js";
import { MemoryError, ProjectMemory } from "./memory.js";
import { loadSkillValidator } from "./skills-axiom.js";
import { CuratedSkills } from "./skills.js";

const authorityFile = process.env.PRAXIS_MCP_CONFIG_FILE;
if (!authorityFile) throw new Error("Set PRAXIS_MCP_CONFIG_FILE to the user-owned MCP authority file.");
const config = mcpAuthoritySchema.parse(JSON.parse(await readFile(authorityFile, "utf8")));
const memory = config.memory && new ProjectMemory(resolve(dirname(authorityFile), config.memory.directory));

async function manageMemory(args: string[]): Promise<void> {
  const [resource, operation, value] = args;
  try {
    if (resource !== "memory" || args.length !== 3 || !value || !["export", "prune"].includes(operation)) {
      throw new MemoryError("unavailable", "Use memory export <new-directory> or memory prune <YYYY-MM-DD>.");
    }
    if (!memory) throw new MemoryError("disabled", "Opt in by configuring a memory directory in the MCP authority file.");
    console.log(JSON.stringify(await (operation === "export" ? memory.export(value) : memory.prune(value))));
  } catch (error) {
    console.error(error instanceof MemoryError ? error.message : "The memory operation is unavailable. Check the path or cutoff date.");
    process.exitCode = 1;
  }
}

async function serve(): Promise<void> {
  const port = Number(process.env.PRAXIS_MCP_PORT ?? 3211);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Set PRAXIS_MCP_PORT to an integer from 0 to 65535.");
  const origin = process.env.PRAXIS_HERMES_ORIGIN;
  const apiKey = process.env.PRAXIS_HERMES_API_KEY;
  if (Boolean(origin) !== Boolean(apiKey)) throw new Error("Set both PRAXIS_HERMES_ORIGIN and PRAXIS_HERMES_API_KEY to enable native inspection.");

  const runtime = origin && apiKey ? new HermesRuntime({ origin, apiKey }) : undefined;
  const validate = config.skills && await loadSkillValidator(process.env.PRAXIS_AXIOM_ROOT ?? "");
  const store = new OperationalStore(config.database);
  const skills = config.skills && validate && {
    service: new CuratedSkills({ directory: resolve(dirname(authorityFile!), config.skills.directory), validate }),
    curatorPrincipalId: config.skills.curatorPrincipalId,
  };
  const path = settingsPath();
  const server = createPraxisMcpServer({
    store, grants: config.grants, runtime, skills,
    memory: memory && { service: memory, enabled: async () => (await readSettings(path)).memory.enabled },
  });
  server.once("close", () => {
    skills?.service.close();
    store.close();
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address !== null && typeof address !== "string") {
      console.log(`Praxis MCP at http://127.0.0.1:${address.port}/mcp`);
    }
  });
}

const args = process.argv.slice(2);
if (args.length === 0) await serve();
else await manageMemory(args);
