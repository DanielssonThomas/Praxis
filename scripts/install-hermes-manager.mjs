import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readSettings, settingsPath } from "@praxis/settings";
import {
  absolute, applyAxiom, assembleAxiom, checkHermes, hermesCommand, mcpEndpoint, prepareDedicatedRoot, present,
} from "./hermes-profile-setup.mjs";

const rootContents = '{"owner":"praxis","schemaVersion":1}\n';
const mcpSetting = "mcp_servers.praxis";

async function prepareRoot(home) {
  await prepareDedicatedRoot(home, ".praxis-manager-root", rootContents);
  const config = join(home, "config.yaml");
  if (!await present(config)) {
    await writeFile(config, "gateway:\n  multiplex_profiles: true\nupdates:\n  check: false\n", { flag: "wx", mode: 0o600 });
  }
}

async function ensureProfile(native, home, profile, endpoint) {
  const directory = join(home, "profiles", profile);
  const soul = join(directory, "SOUL.md");
  const marker = join(directory, ".praxis-manager-seeded");
  if (!await present(directory)) {
    const seed = await readFile(new URL("./hermes-manager-soul.md", import.meta.url));
    const temporary = join(directory, `.praxis-soul-${randomUUID()}`);
    try {
      await native(["profile", "create", profile, "--no-credentials", "--no-alias", "--no-skills"]);
      if (await realpath(directory) !== directory) throw new Error("Unexpected redirected profile directory.");
      await writeFile(temporary, seed, { flag: "wx", mode: 0o600 });
      await rename(temporary, soul);
    } catch {
      throw new Error("Hermes could not create and seed the named manager profile.");
    } finally {
      await rm(temporary, { force: true });
    }
  }
  if (await realpath(directory) !== directory) throw new Error("Use an independent physical Hermes profile directory.");
  if (!await present(marker)) {
    const seed = await readFile(new URL("./hermes-manager-soul.md", import.meta.url));
    const installedSeed = await readFile(soul).catch((error) => {
      if (error.code === "ENOENT") return;
      throw error;
    });
    if (!installedSeed?.equals(seed)) {
      throw new Error("The selected profile lacks a completed Praxis manager seed. Choose a fresh named profile or restore the Praxis seed before retrying.");
    }
    await writeFile(marker, "1\n", { flag: "wx", mode: 0o600 });
  } else if (await readFile(marker, "utf8") !== "1\n") {
    throw new Error("The selected profile has an unsupported Praxis manager seed marker.");
  }

  try {
    await native(["-p", profile, "config", "get", mcpSetting, "--json"]);
  } catch (error) {
    if (!`${error.stdout ?? ""}\n${error.stderr ?? ""}`.includes(`Config key not set: ${mcpSetting}`)) {
      throw new Error("Hermes could not read the manager profile MCP configuration.");
    }
    try {
      await native(["-p", profile, "config", "set", mcpSetting, JSON.stringify({
        url: endpoint,
        headers: { Authorization: "Bearer ${PRAXIS_MCP_TOKEN}" },
      })]);
    } catch {
      throw new Error("Hermes could not configure the local Praxis MCP entry.");
    }
  }
}

async function install(values) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("This installer supports Linux x64.");
  }
  const endpoint = mcpEndpoint(values["mcp-origin"]);
  const binary = absolute(values["hermes-bin"], "--hermes-bin");
  const home = absolute(values["hermes-home"], "--hermes-home");
  const { manager: { profile }, policy } = await readSettings(settingsPath());
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile) || profile === "default") {
    throw new Error("Select a named manager profile using lowercase letters, digits and single hyphens.");
  }
  if (policy.axiomEnabled && policy.profiles.length > 0) {
    throw new Error("This installer supports the default Axiom core. Configure optional profiles through Axiom.");
  }

  // Prepare a disposable home for version discovery. Hermes may create native state directories.
  const staging = await mkdtemp(join(tmpdir(), "praxis-manager-setup-"));
  try {
    await checkHermes(binary, staging);
    const axiom = policy.axiomEnabled ? await assembleAxiom(absolute(values["axiom-root"], "--axiom-root"), staging) : undefined;
    await prepareRoot(home);
    await ensureProfile(hermesCommand(binary, home), home, profile, endpoint);

    const localPolicy = applyAxiom(axiom, { home, profile }, values.update);
    console.log(JSON.stringify({ profile, home, policy: localPolicy }));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

try {
  const { values } = parseArgs({
    options: {
      "hermes-bin": { type: "string" },
      "hermes-home": { type: "string" },
      "axiom-root": { type: "string" },
      "mcp-origin": { type: "string" },
      update: { type: "boolean" },
    },
  });
  await install(values);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
