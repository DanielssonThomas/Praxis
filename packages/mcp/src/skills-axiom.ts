import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { SkillCurationError } from "./skills.js";
import type { PublishedSkill, SkillEvaluation } from "./skills.js";

const execute = promisify(execFile);
const revision = "96014e73ca14111be83c448898e41559f0f87f88";

interface PolicySource {
  path: string;
  text: string;
}

interface PolicyModule {
  resolvePolicy(catalog: {
    core: PolicySource & { version: string };
    profiles: [];
    checks: Record<string, never>;
    skills: PolicySource[];
    evaluations: PolicySource[];
  }, profiles: []): { policy?: unknown; diagnostics: readonly unknown[] };
}

export async function loadSkillValidator(root: string) {
  if (!isAbsolute(root)) throw new Error("Set PRAXIS_AXIOM_ROOT to the absolute path of the built pinned Axiom checkout.");
  try {
    const git = (...args: string[]) => execute("git", ["-C", root, ...args], { timeout: 5_000 });
    if ((await git("rev-parse", "HEAD")).stdout.trim() !== revision) throw new Error("Unexpected revision.");
    await git("diff", "--quiet", "HEAD", "--");
    const [modules, text, directories] = await Promise.all([
      import(pathToFileURL(join(root, "packages/policy/dist/index.js")).href) as Promise<PolicyModule>,
      readFile(join(root, "core/AXIOMS.md"), "utf8"),
      readdir(join(root, "skills"), { withFileTypes: true }),
    ]);
    const reserved = new Set(directories.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    return ({ skillId, version, markdown }: PublishedSkill, evaluation: SkillEvaluation) => {
      if (reserved.has(skillId)) throw new SkillCurationError("invalid_skill", "Use the canonical Axiom skill for this name.");
      const target = evaluation.skill;
      if (target === null || typeof target !== "object" || Array.isArray(target)
        || target.id !== skillId || target.version !== String(version)) {
        throw new SkillCurationError("invalid_skill", "The Axiom evaluation must target this skill and version.");
      }
      const path = "skills/" + skillId;
      const result = modules.resolvePolicy({
        core: { path: "core/AXIOMS.md", version: "1", text }, profiles: [], checks: {},
        skills: [{ path: path + "/SKILL.md", text: markdown }],
        evaluations: [{ path: path + "/evals/curation.json", text: JSON.stringify(evaluation) }],
      }, []);
      if (!result.policy || result.diagnostics.length > 0) {
        throw new SkillCurationError("invalid_skill", "The published Markdown failed pinned Axiom skill validation.");
      }
    };
  } catch (cause) {
    throw new Error("Skill curation requires a clean, built checkout of the pinned Axiom revision.", { cause });
  }
}
