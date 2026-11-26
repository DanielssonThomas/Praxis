import { execFile } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const axiomRevision = "ef35e6f5fb881db878a9547f124f8c28a08b414e";

// Describe only the interfaces Praxis consumes from the owner's built checkout.
// The pinned Axiom packages own parsing, policy resolution and evidence assessment.
interface PolicyIdentity {
  version: string;
  digest: string;
  profiles: readonly { id: string; version: string }[];
}

interface Brief {
  id: string;
  parentId?: string;
  ownedPaths: string[];
  criteria: readonly { id: string; required: boolean }[];
  limits: { maxAttempts: number; maxConcurrency: number };
  policy: PolicyIdentity;
}

interface HostIdentity {
  agent: string;
  version: string;
  model: string;
  os: string;
  surface: string;
}

interface SourceScope {
  root: string;
  extraFiles?: readonly string[];
  excludedPaths?: readonly string[];
}

export interface SourceIdentity {
  revision?: string;
  digest: string;
}

interface PlanRequest {
  root: string;
  task: Brief;
  requirements: readonly unknown[];
}

interface Plan extends PlanRequest {
  checks: readonly { sources: readonly { path: string }[] }[];
}

interface VerificationResult {
  id: string;
  criterionId: string;
  required: boolean;
  evidenceId?: string;
  outcome: { status: string; reason?: string };
}

export interface VerificationReport {
  conforms: boolean;
  checks: readonly VerificationResult[];
}

export interface VerificationRun {
  id: string;
  plan: Plan;
  host?: HostIdentity;
  report: VerificationReport;
}

export interface VerifyOptions {
  capabilities?: readonly { id: string; available: boolean; reason?: string }[];
  signal?: AbortSignal;
}

export interface PolicyAxiom {
  readonly axiomRoot?: string;
  readonly evidenceRoot?: string;
  parseBrief(value: unknown): Brief;
  parseHost(value: unknown): HostIdentity;
  policy(): PolicyIdentity;
  snapshot(scope: SourceScope): Promise<SourceIdentity>;
  plan(request: PlanRequest): Promise<Plan>;
  verify(plan: Plan, host: HostIdentity, options: VerifyOptions): Promise<VerificationRun>;
  assess(run: VerificationRun): Promise<VerificationReport>;
  evidenceStartedAt(id: string): Promise<string | undefined>;
}

interface EvidenceStore {
  read(phase: "acceptance", id: string): Promise<{ startedAt: string } | undefined>;
}

interface AxiomModules {
  contracts: {
    taskBriefSchema: { parse(value: unknown): Brief };
    hostIdentitySchema: { parse(value: unknown): HostIdentity };
  };
  policy: {
    resolvePolicy(catalog: unknown, profiles: readonly string[]): { policy?: { identity: PolicyIdentity }; diagnostics: unknown[] };
  };
  evidence: {
    EvidenceStore: new (directory: string) => EvidenceStore;
    snapshotSource(scope: SourceScope): Promise<SourceIdentity>;
  };
  verification: {
    planVerification(request: PlanRequest): Promise<Plan>;
    executeVerification(request: VerifyOptions & { plan: Plan; host: HostIdentity; store: EvidenceStore }): Promise<VerificationRun>;
    assessVerification(run: VerificationRun, store: EvidenceStore): Promise<VerificationReport>;
  };
}

const execute = promisify(execFile);

export async function loadPolicyAxiom(axiomRoot: string, evidenceRoot: string): Promise<PolicyAxiom> {
  if (!isAbsolute(axiomRoot) || !isAbsolute(evidenceRoot)) throw new Error("Axiom and evidence roots must be absolute paths.");
  const root = await realpath(axiomRoot);
  const git = (args: string[]) => execute("git", ["-C", root, ...args], { timeout: 5_000 });
  if ((await git(["rev-parse", "HEAD"])).stdout.trim() !== axiomRevision || (await git(["status", "--porcelain"])).stdout) {
    throw new Error("Use the extracted Axiom v1 runtime from the qualified release.");
  }
  const load = <Key extends keyof AxiomModules>(name: Key): Promise<AxiomModules[Key]> =>
    import(pathToFileURL(join(root, "packages", name, "dist/index.js")).href);
  const [contracts, policy, evidence, verification, core] = await Promise.all([
    load("contracts"), load("policy"), load("evidence"), load("verification"), readFile(join(root, "core/AXIOMS.md"), "utf8"),
  ]);
  const resolved = policy.resolvePolicy({ core: { path: "core/AXIOMS.md", version: "1", text: core }, profiles: [], checks: {} }, []);
  if (resolved.policy === undefined || resolved.diagnostics.length) throw new Error("The pinned core policy did not resolve.");
  const identity = resolved.policy.identity;
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const archive = await realpath(evidenceRoot);
  const store = new evidence.EvidenceStore(archive);
  return {
    axiomRoot: root,
    evidenceRoot: archive,
    parseBrief: (value) => contracts.taskBriefSchema.parse(value),
    parseHost: (value) => contracts.hostIdentitySchema.parse(value),
    policy: () => identity,
    snapshot: evidence.snapshotSource,
    plan: verification.planVerification,
    verify: (plan, host, options) => verification.executeVerification({ ...options, plan, host, store }),
    assess: (run) => verification.assessVerification(run, store),
    evidenceStartedAt: async (id) => (await store.read("acceptance", id))?.startedAt,
  };
}
