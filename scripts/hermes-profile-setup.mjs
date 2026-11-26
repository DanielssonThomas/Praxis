import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const axiomRevision = "ef35e6f5fb881db878a9547f124f8c28a08b414e";
const bundleDigest = "sha256:59724db639fe977f032157fbaa3ee45b883a18bc152b6d0bc5e3b7ab9a337c9d";

export async function present(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function absolute(value, flag) {
  if (!value || !isAbsolute(value)) throw new Error(`Supply an absolute path for ${flag}.`);
  return resolve(value);
}

export function mcpEndpoint(value = "http://127.0.0.1:3211/mcp") {
  const syntax = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/mcp$/;
  if (!syntax.test(value) || !URL.parse(value)) {
    throw new Error("Praxis MCP must use a loopback HTTP endpoint ending in /mcp.");
  }
  return value;
}

export async function prepareDedicatedRoot(home, markerName, contents) {
  const defaultHome = join(homedir(), ".hermes");
  const fromDefault = relative(defaultHome, home);
  if ((!fromDefault.startsWith("../") && fromDefault !== "..") || basename(dirname(home)) === "profiles") {
    throw new Error("Choose a dedicated Hermes root outside the existing default home and named profiles.");
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (await realpath(home) !== home) throw new Error("Use the real path of the dedicated Hermes root.");

  const marker = join(home, markerName);
  if (!await present(marker)) {
    if ((await readdir(home)).length !== 0) throw new Error("Use an empty root or one previously installed by Praxis.");
    await writeFile(marker, contents, { flag: "wx", mode: 0o600 });
  } else if (await readFile(marker, "utf8") !== contents) {
    throw new Error("The selected Hermes root has an unsupported Praxis installation marker.");
  }
}

export function hermesCommand(binary, home) {
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

export async function checkHermes(binary, home) {
  try {
    const { stdout } = await hermesCommand(binary, home)(["--version"]);
    if (/^Hermes Agent v0\.23\.3\b/m.test(stdout)) return;
  } catch {
    throw new Error("The Hermes launcher could not report its version.");
  }
  throw new Error("This installer supports Hermes Agent 0.23.3 on Linux x64.");
}

export async function assembleAxiom(root, output) {
  const git = (args) => execute("git", ["-C", root, ...args], { timeout: 10_000 });
  try {
    const { stdout: revision } = await git(["rev-parse", "HEAD"]);
    const { stdout: status } = await git(["status", "--porcelain"]);
    if (revision.trim() === axiomRevision && !status) {
      const load = (path) => import(pathToFileURL(join(root, path)));
      const { assembleBundles, loadBundleWorkspace, writeBundles } = await load("packages/bundles/dist/index.js");
      const { changeHermesPlugin, hermesBundleAdapter, inspectHermesActivation } = await load("adapters/hermes/dist/index.js");
      const { catalog, skills } = loadBundleWorkspace(root);
      const [artifact] = assembleBundles(root, {
        version: "0.1.0", sourceRevision: axiomRevision, policyVersion: catalog.core.version,
        selectedProfiles: [], checks: catalog.checks, skills, adapters: [hermesBundleAdapter],
      });
      if (artifact.manifest.digest !== bundleDigest) throw new Error("The assembled Hermes bundle differs from the qualified artifact.");
      const [bundle] = writeBundles(output, [artifact]);
      return { bundle, changeHermesPlugin, inspectHermesActivation };
    }
  } catch {
    throw new Error("Use the extracted Axiom v1 runtime with its qualified Hermes bundle.");
  }
  throw new Error("Use the extracted runtime of Axiom v1.0.0.");
}

export function applyAxiom(axiom, target, update, replacementFlag = "--update") {
  if (!axiom) return { status: "preserved" };
  const { inspectHermesActivation, bundle, changeHermesPlugin } = axiom;
  const installed = inspectHermesActivation(target).installed.status === "passed";
  const result = changeHermesPlugin(target, {
    kind: update && installed ? "update" : "install",
    bundle: bundle.directory,
  });
  if (result.outcome.status !== "passed") {
    throw new Error(`Axiom could not install the pinned bundle. Use ${replacementFlag} to replace a previously managed bundle.`);
  }
  const observed = inspectHermesActivation(target);
  if (observed.installed.status !== "passed" || observed.bundleDigest !== bundle.manifest.digest) {
    throw new Error("The local profile did not report the installed pinned Axiom bundle.");
  }
  return { status: observed.enabled ? "enabled" : "disabled", digest: observed.policy.digest };
}
