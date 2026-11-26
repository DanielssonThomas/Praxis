import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const axiomRevision = "ef35e6f5fb881db878a9547f124f8c28a08b414e";

interface PolicyIdentity {
  version: string;
  digest: string;
  profiles: readonly { id: string; version: string }[];
}

export interface Brief {
  id: string;
  policy: PolicyIdentity;
  ownedPaths: string[];
  limits: { timeoutMs: number; maxAttempts: number; maxConcurrency: number };
  requiredCapabilities: string[];
}

interface Bundle {
  policy: PolicyIdentity;
  instructions: string;
  skills: string[];
}

export interface AxiomProfile {
  program: string;
  home: string;
  userHome: string;
  workspace: string;
  environment: Record<string, string>;
}

interface AxiomModules {
  contracts: { taskBriefSchema: { parse(value: unknown): Brief } };
  adapter: {
    buildCodexBundle(value: unknown): Promise<Bundle>;
    configureCodexProfile(profile: AxiomProfile, action: "install", bundle: Bundle, signal: AbortSignal): Promise<void>;
    observeCodexProfile(profile: AxiomProfile, signal: AbortSignal): Promise<{
      discovered: boolean; selected: boolean; contexts: string[]; skills: string[];
    }>;
  };
}

export async function loadAxiom(root: string) {
  if (!isAbsolute(root)) throw new Error("Supply an absolute Axiom checkout path.");
  const git = (args: string[]) => execute("git", ["-C", root, ...args], { timeout: 5_000 });
  if ((await git(["rev-parse", "HEAD"])).stdout.trim() !== axiomRevision) throw new Error("Unexpected Axiom revision.");
  await git(["diff", "--quiet", "HEAD", "--"]);
  const load = (path: string) => import(pathToFileURL(join(root, path)).href);
  const [contracts, adapter, core] = await Promise.all([
    load("packages/contracts/dist/index.js"),
    load("adapters/codex/dist/index.js"),
    readFile(join(root, "core/AXIOMS.md"), "utf8"),
  ]);
  return {
    parse(value: unknown): Brief {
      return (contracts as AxiomModules["contracts"]).taskBriefSchema.parse(value);
    },
    async prepare(profile: AxiomProfile, brief: Brief, destination: string, signal: AbortSignal): Promise<void> {
      const native = adapter as AxiomModules["adapter"];
      const bundle = await native.buildCodexBundle({
        source: root, destination, version: "0.1.0", profiles: [],
        catalog: { core: { path: "core/AXIOMS.md", version: "1", text: core }, profiles: [], checks: {} },
      });
      if (JSON.stringify(brief.policy) !== JSON.stringify(bundle.policy)) throw new Error("Axiom policy identity mismatch.");
      await native.configureCodexProfile(profile, "install", bundle, signal);
      const status = await native.observeCodexProfile(profile, signal);
      if (!status.discovered || !status.selected || !status.contexts.includes(bundle.instructions)
        || !bundle.skills.every((name) => status.skills.includes(`axiom:${name}`))) {
        throw new Error("The Codex profile did not load the selected Axiom policy.");
      }
    },
  };
}
