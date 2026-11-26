import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { principalIdSchema, sessionIdSchema, taskIdSchema } from "@praxis/contracts";
import { z } from "zod";

const absolutePath = z.string().refine(isAbsolute, "Use an absolute local path");
const assignmentSchema = z.strictObject({
  taskId: taskIdSchema,
  sessionId: sessionIdSchema,
  sourceRevision: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  authority: z.strictObject({
    revision: z.int().positive(), root: absolutePath, brief: z.unknown(), requirements: z.array(z.unknown()),
    protectedPaths: z.array(z.string()), verificationHost: z.unknown(), reviewerId: principalIdSchema,
  }),
}).refine(({ authority }) => authority.brief !== undefined && authority.verificationHost !== undefined);

const delegationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  axiomRoot: absolutePath, evidenceRoot: absolutePath, workerRoot: absolutePath, program: absolutePath,
  profile: z.strictObject({
    root: absolutePath,
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/),
    authentication: z.enum(["file", "none"]),
  }),
  assignments: z.array(assignmentSchema).refine((rows) => new Set(rows.map(({ taskId }) => taskId)).size === rows.length
    && new Set(rows.map(({ sessionId }) => sessionId)).size === rows.length, "Use unique enrolled task and session IDs"),
});

export type CodexDelegationConfig = z.infer<typeof delegationSchema>;
export type CodexEnrollment = z.infer<typeof assignmentSchema>;
const run = promisify(execFile);

export function codexDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseCodexDelegation(value: unknown): CodexDelegationConfig {
  return delegationSchema.parse(value);
}

export async function readCodexDelegation(file: string): Promise<CodexDelegationConfig> {
  return parseCodexDelegation(JSON.parse(await readFile(file, "utf8")));
}

export function workerProcessEnvironment(): NodeJS.ProcessEnv {
  const keys = ["PATH", "HOME", "PRAXIS_MCP_CONFIG_FILE", "PRAXIS_CODEX_DELEGATION_FILE", "PRAXIS_OPERATOR_TOKEN_DIGEST",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]).filter(([, value]) => value !== undefined));
}

function git(args: string[], signal?: AbortSignal) {
  return run("git", args, { timeout: 10_000, signal, env: {
    PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  } });
}

export async function checkoutMatches(root: string, revision: string, requireClean: boolean, signal?: AbortSignal): Promise<boolean> {
  const observed = await git(["-C", root, "rev-parse", "--show-toplevel", "HEAD"], signal);
  const [directory, head] = observed.stdout.trimEnd().split("\n");
  if (directory !== root) return false;
  if (!requireClean) {
    return head === revision || await git(["-C", root, "merge-base", "--is-ancestor", revision, "HEAD"], signal)
      .then(() => true, () => false);
  }
  if (head !== revision) return false;
  return (await git(["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], signal)).stdout === "";
}

export async function cloneCodexCheckout(root: string, workspace: string, revision: string, signal: AbortSignal): Promise<void> {
  if (!await checkoutMatches(root, revision, true, signal)) throw new Error("The enrolled checkout no longer matches its approved revision.");
  await git(["clone", "--quiet", "--no-local", "--no-hardlinks", "--", root, workspace], signal);
  if (!await checkoutMatches(workspace, revision, true, signal)) throw new Error("The staged Git checkout does not match the enrolled revision.");
}

function within(parent: string, candidate: string): boolean {
  const offset = relative(parent, candidate);
  return !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
}

function overlaps(left: string, right: string): boolean {
  return within(left, right) || within(right, left);
}

export async function resolveCodexEnrollment(config: CodexDelegationConfig, enrollment: CodexEnrollment) {
  const [source, axiomRoot, program, profileRoot] = await Promise.all([
    realpath(enrollment.authority.root), realpath(config.axiomRoot), realpath(config.program), realpath(config.profile.root),
  ]);
  const defaultProfile = await realpath(join(homedir(), ".codex")).catch(() => resolve(homedir(), ".codex"));
  const knownRoots = [source, axiomRoot, profileRoot];
  if (overlaps(defaultProfile, profileRoot) || knownRoots.some((root, index) => knownRoots.slice(index + 1).some((other) => overlaps(root, other)))) {
    throw new Error("Use a dedicated Codex profile and independent source and Axiom roots.");
  }
  const configuredRoots: [string, string] = [resolve(config.workerRoot), resolve(config.evidenceRoot)];
  if (overlaps(...configuredRoots) || configuredRoots.some((path) => knownRoots.some((root) => overlaps(root, path)))) {
    throw new Error("Keep worker and evidence storage outside the dedicated profile and source checkouts.");
  }
  await Promise.all(configuredRoots.map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const [workerRoot, evidenceRoot] = await Promise.all(configuredRoots.map((path) => realpath(path)));
  if (overlaps(workerRoot, evidenceRoot) || [workerRoot, evidenceRoot].some((path) => knownRoots.some((root) => overlaps(root, path)))) {
    throw new Error("Worker and evidence paths must stay physically separate from the checkouts and profile.");
  }
  const binary = await stat(program);
  if (!binary.isFile()) throw new Error("Use the pinned Codex binary from the complete distribution.");
  const profile = { ...config.profile, root: profileRoot };
  return { axiomRoot, evidenceRoot, workerRoot, program, profile, binaryIdentity: [binary.dev, binary.ino, binary.size, binary.mtimeMs], enrollment: { ...enrollment,
    authority: { ...enrollment.authority, root: source },
  } };
}

async function profileFile(path: string, required: boolean): Promise<Buffer | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    if (!required && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size === 0) throw new Error("The dedicated Codex profile file is unavailable.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readCodexProfile(profile: CodexDelegationConfig["profile"]) {
  const usesLocalLogin = profile.authentication === "file";
  const [settings, login] = await Promise.all([
    profileFile(join(profile.root, "config.toml"), !usesLocalLogin),
    usesLocalLogin ? profileFile(join(profile.root, "auth.json"), true) : undefined,
  ]);
  const stamp = (value: Buffer | undefined) => value && createHash("sha256").update(value).digest("hex");
  return { settings, login, identity: codexDigest([stamp(settings), stamp(login)]) };
}

export async function codexProfileIdentity(profile: CodexDelegationConfig["profile"]): Promise<string> {
  return (await readCodexProfile(profile)).identity;
}

export async function stageCodexProfile(profile: CodexDelegationConfig["profile"], codexHome: string, expected: string): Promise<void> {
  const { settings, login, identity } = await readCodexProfile(profile);
  if (identity !== expected) throw new Error("The selected Codex profile changed after approval.");
  await Promise.all([
    settings && writeFile(join(codexHome, "config.toml"), settings, { flag: "wx", mode: 0o600 }),
    login && writeFile(join(codexHome, "auth.json"), login, { flag: "wx", mode: 0o600 }),
  ]);
}
