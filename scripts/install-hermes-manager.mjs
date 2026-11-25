import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { readSettings, settingsPath } from "@praxis/settings";

const execute = promisify(execFile);
const axiomRevision = "96014e73ca14111be83c448898e41559f0f87f88";
const bundleDigest = "sha256:1c8490c639d37160b46ac8946ba008839f5043103178afee32f8423c79d7b4cf";
const rootContents = '{"owner":"praxis","schemaVersion":1}\n';
const mcpSetting = "mcp_servers.praxis";

async function present(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function absolute(value, flag) {
  if (!value || !isAbsolute(value)) throw new Error(`Supply an absolute path for ${flag}.`);
  return resolve(value);
}

function mcpEndpoint(value = "http://127.0.0.1:3211/mcp") {
  const syntax = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/mcp$/;
  if (!syntax.test(value) || !URL.parse(value)) {
    throw new Error("Praxis MCP must use a loopback HTTP endpoint ending in /mcp.");
  }
  return value;
}

async function prepareRoot(home) {
  const defaultHome = join(homedir(), ".hermes");
  const fromDefault = relative(defaultHome, home);
  if ((!fromDefault.startsWith("../") && fromDefault !== "..") || basename(dirname(home)) === "profiles") {
    throw new Error("Choose a dedicated Hermes root outside the existing default home and named profiles.");
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (await realpath(home) !== home) throw new Error("Use the real path of the dedicated Hermes root.");

  const marker = join(home, ".praxis-manager-root");
  if (!await present(marker)) {
    if ((await readdir(home)).length !== 0) throw new Error("Use an empty root or one previously installed by Praxis.");
    await writeFile(marker, rootContents, { flag: "wx", mode: 0o600 });
  } else if (await readFile(marker, "utf8") !== rootContents) {
    throw new Error("The selected Hermes root has an unsupported Praxis installation marker.");
  }

  const config = join(home, "config.yaml");
  if (!await present(config)) {
    await writeFile(config, "gateway:\n  multiplex_profiles: true\nupdates:\n  check: false\n", { flag: "wx", mode: 0o600 });
  }
}

function hermesCommand(binary, home) {
  const env = {
    PATH: process.env.PATH,
    HOME: homedir(),
    HERMES_HOME: home,
    HERMES_DISABLE_LAZY_INSTALLS: "1",
    HERMES_NO_SYSTEMD: "1",
    TERM: "dumb",
  };
  return (args) => execute(binary, args, { env, timeout: 30_000 });
}

async function checkHermes(binary, home) {
  // Query the executable before creating or changing the target root.
  try {
    const { stdout } = await hermesCommand(binary, home)(["--version"]);
    if (/^Hermes Agent v0\.23\.3\b/m.test(stdout)) return;
  } catch {
    throw new Error("The Hermes launcher could not report its version.");
  }
  throw new Error("This installer supports Hermes Agent 0.23.3 on Linux x64.");
}

async function assembleAxiom(root, output) {
  const git = (args) => execute("git", ["-C", root, ...args], { timeout: 10_000 });
  try {
    const { stdout: revision } = await git(["rev-parse", "HEAD"]);
    const { stdout: status } = await git(["status", "--porcelain"]);
    if (revision.trim() === axiomRevision && !status) {
      const load = (path) => import(pathToFileURL(join(root, path)));
      const { assembleBundles, writeBundles } = await load("packages/bundles/dist/index.js");
      const { changeHermesPlugin, hermesBundleAdapter, inspectHermesActivation } = await load("adapters/hermes/dist/index.js");
      const skills = ["context", "delegate", "design", "diagnose", "knowledge", "verify"].map((id) => ({ id }));
      const [artifact] = assembleBundles(root, {
        version: "0.1.0", sourceRevision: axiomRevision, policyVersion: "1",
        selectedProfiles: [], checks: {}, skills, adapters: [hermesBundleAdapter],
      });
      if (artifact.manifest.digest !== bundleDigest) throw new Error("The assembled Hermes bundle differs from the qualified artifact.");
      const [bundle] = writeBundles(output, [artifact]);
      return { bundle, changeHermesPlugin, inspectHermesActivation };
    }
  } catch {
    throw new Error("Build and use a clean Axiom checkout of the pinned revision with its qualified Hermes bundle.");
  }
  throw new Error("Use a clean Axiom checkout of the pinned revision.");
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

    let localPolicy = { status: "preserved" };
    if (axiom) {
      const target = { home, profile };
      const { inspectHermesActivation, bundle, changeHermesPlugin } = axiom;
      const installed = inspectHermesActivation(target).installed.status === "passed";
      const result = changeHermesPlugin(target, {
        kind: values.update && installed ? "update" : "install",
        bundle: bundle.directory,
      });
      if (result.outcome.status !== "passed") {
        throw new Error("Axiom could not install the pinned bundle. Use --update to replace a previously managed bundle.");
      }
      const observed = inspectHermesActivation(target);
      if (observed.installed.status !== "passed" || observed.bundleDigest !== bundle.manifest.digest) {
        throw new Error("The local profile did not report the installed pinned Axiom bundle.");
      }
      localPolicy = { status: observed.enabled ? "enabled" : "disabled", digest: observed.policy.digest };
    }
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
