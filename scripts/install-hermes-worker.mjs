import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readSettings, settingsPath } from "@praxis/settings";
import {
  absolute, applyAxiom, assembleAxiom, checkHermes, hermesCommand, mcpEndpoint, prepareDedicatedRoot, present,
} from "./hermes-profile-setup.mjs";

const rootMarker = ".praxis-worker-root";
const profileMarker = ".praxis-worker-seeded";
const seedVersion = "1\n";
const toolset = ["mcp-praxis"];
const workerTools = ["inspect_task", "inspect_worker", "report_worker", "propose_skill", "load_curated_skill"];
const usage = "node scripts/install-hermes-worker.mjs --hermes-bin PATH --hermes-home PATH --profile NAME [--axiom-root PATH] [--mcp-origin URL] [--replace]";

async function configureProfile(native, profile, endpoint) {
  const config = [
    ["platform_toolsets", { cli: toolset, api_server: toolset }],
    ["gateway.standalone", true],
    ["tools.connectors.enabled", false],
    ["tools.tool_search.enabled", false],
    ["kanban.dispatch_in_gateway", false],
    ["mcp_servers.praxis", {
      url: endpoint,
      headers: { Authorization: "Bearer ${PRAXIS_MCP_TOKEN}" },
      tools: { include: workerTools, prompts: false, resources: false },
    }],
  ];
  try {
    for (const [key, value] of config) {
      await native(["-p", profile, "config", "set", key, JSON.stringify(value)]);
    }
  } catch {
    throw new Error("Hermes could not configure the worker's scoped Praxis tools.");
  }
}

async function installProfile(home, profile, binary, endpoint, axiom, replace) {
  const profiles = join(home, "profiles");
  const directory = join(profiles, profile);
  const seed = await readFile(new URL("./hermes-worker-soul.md", import.meta.url));
  if (await present(directory)) {
    if (await realpath(directory) !== directory) throw new Error("Use an independent physical Hermes worker profile directory.");
    const marker = join(directory, profileMarker);
    if (!await present(marker) || await realpath(marker) !== marker || await readFile(marker, "utf8") !== seedVersion) {
      throw new Error("The selected profile is outside this worker installer's ownership.");
    }
    const policy = applyAxiom(axiom, { home, profile }, replace, "--replace");
    if (replace) {
      const temporary = join(directory, `.praxis-soul-${randomUUID()}`);
      try {
        await writeFile(temporary, seed, { flag: "wx", mode: 0o600 });
        await rename(temporary, join(directory, "SOUL.md"));
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return policy;
  }

  // Hermes should see the named profile only after its restrictions, seed and policy are in place.
  const staging = await mkdtemp(join(home, ".praxis-worker-stage-"));
  try {
    const native = hermesCommand(binary, staging);
    try {
      await native(["-p", "default", "profile", "create", profile, "--no-credentials", "--no-alias", "--no-skills"]);
    } catch {
      throw new Error("Hermes could not create the named worker profile.");
    }
    const stagedProfile = join(staging, "profiles", profile);
    if (await realpath(stagedProfile) !== stagedProfile) throw new Error("Hermes redirected the new worker profile.");
    await rm(join(stagedProfile, "SOUL.md"), { force: true });
    await writeFile(join(stagedProfile, "SOUL.md"), seed, { flag: "wx", mode: 0o600 });
    await configureProfile(native, profile, endpoint);
    const policy = applyAxiom(axiom, { home: staging, profile }, false, "--replace");
    await writeFile(join(stagedProfile, profileMarker), seedVersion, { flag: "wx", mode: 0o600 });
    await mkdir(profiles, { recursive: true, mode: 0o700 });
    if (await realpath(profiles) !== profiles) throw new Error("Use a physical Hermes worker profiles directory.");
    await rename(stagedProfile, directory);
    return policy;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function install(values) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("This installer supports Linux x64.");
  const endpoint = mcpEndpoint(values["mcp-origin"]);
  const binary = absolute(values["hermes-bin"], "--hermes-bin");
  const home = absolute(values["hermes-home"], "--hermes-home");
  const profile = values.profile;
  if (!profile || profile.length > 64 || profile === "default" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile)) {
    throw new Error("Select a named worker profile using up to 64 lowercase letters, digits and single hyphens.");
  }
  const { policy } = await readSettings(settingsPath());
  if (policy.axiomEnabled && policy.profiles.length) {
    throw new Error("This installer supports the default Axiom core. Configure optional profiles through Axiom.");
  }

  const staging = await mkdtemp(join(tmpdir(), "praxis-worker-setup-"));
  try {
    await checkHermes(binary, staging);
    const axiom = policy.axiomEnabled ? await assembleAxiom(absolute(values["axiom-root"], "--axiom-root"), staging) : undefined;
    await prepareDedicatedRoot(home, rootMarker, JSON.stringify({ owner: "praxis", schemaVersion: 1, profile }) + "\n");
    const marker = join(home, rootMarker);
    if (await realpath(marker) !== marker) throw new Error("Use a physical Hermes worker installation marker.");
    const localPolicy = await installProfile(home, profile, binary, endpoint, axiom, values.replace);
    console.log(JSON.stringify({ profile, home, policy: localPolicy }));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

try {
  const { values } = parseArgs({ options: {
    "hermes-bin": { type: "string" }, "hermes-home": { type: "string" }, profile: { type: "string" },
    "axiom-root": { type: "string" }, "mcp-origin": { type: "string" }, replace: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) console.log(usage);
  else await install(values);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
