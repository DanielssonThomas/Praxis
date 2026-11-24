import { readFile } from "node:fs/promises";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { OperationalStore } from "@praxis/state";
import { createPraxisMcpServer, mcpAuthoritySchema } from "./index.js";

const authorityFile = process.env.PRAXIS_MCP_CONFIG_FILE;
if (!authorityFile) throw new Error("Set PRAXIS_MCP_CONFIG_FILE to the user-owned MCP authority file.");
const config = mcpAuthoritySchema.parse(JSON.parse(await readFile(authorityFile, "utf8")));

const port = Number(process.env.PRAXIS_MCP_PORT ?? 3211);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Set PRAXIS_MCP_PORT to an integer from 0 to 65535.");
const origin = process.env.PRAXIS_HERMES_ORIGIN;
const apiKey = process.env.PRAXIS_HERMES_API_KEY;
if (Boolean(origin) !== Boolean(apiKey)) throw new Error("Set both PRAXIS_HERMES_ORIGIN and PRAXIS_HERMES_API_KEY to enable native inspection.");

const runtime = origin && apiKey ? new HermesRuntime({ origin, apiKey }) : undefined;
const store = new OperationalStore(config.database);
const server = createPraxisMcpServer({ store, grants: config.grants, runtime });
server.once("close", () => store.close());
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address !== null && typeof address !== "string") {
    console.log(`Praxis MCP at http://127.0.0.1:${address.port}/mcp`);
  }
});
