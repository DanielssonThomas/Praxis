import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CodexSkillResource {
  skillId: string;
  markdown: string;
  digest: string;
}

export async function stageCuratedSkills(home: string, selected: readonly CodexSkillResource[], signal: AbortSignal): Promise<void> {
  if (selected.length > 16 || new Set(selected.map(({ skillId }) => skillId)).size !== selected.length) {
    throw new Error("Select up to 16 distinct curated skills for this Codex assignment.");
  }
  for (const { skillId, markdown, digest } of selected) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillId) || skillId.length > 64 || markdown.length > 14_000
      || createHash("sha256").update(markdown).digest("hex") !== digest) {
      throw new Error("The selected Codex skill did not pass its integrity check.");
    }
    const directory = join(home, ".agents", "skills", skillId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "SKILL.md"), markdown, { mode: 0o600, flag: "wx", signal });
  }
}
