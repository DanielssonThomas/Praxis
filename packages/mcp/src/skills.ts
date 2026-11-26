import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eventIdSchema, sessionIdSchema, taskIdSchema } from "@praxis/contracts";
import { z } from "zod";

export const skillIdSchema = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const findingKeySchema = z.string().max(80)
  .transform((value) => value.trim().toLowerCase().replace(/[\s_]+/g, "-")).pipe(skillIdSchema);
const summary = z.string().trim().min(1).max(512);
const note = z.string().trim().min(1).max(2_048);
const revision = z.int().positive();

export const skillSelectionSchema = z.strictObject({ skillId: skillIdSchema, version: revision });
export const proposedSkillSchema = z.strictObject({
  sessionId: sessionIdSchema,
  submissionId: eventIdSchema,
  findingKey: findingKeySchema,
  observation: note,
  evidence: note,
});
export const inspectProposalsSchema = z.strictObject({ findingKey: findingKeySchema.optional() });
export const reviewProposalsSchema = z.strictObject({ findingKey: findingKeySchema, revision, taskId: taskIdSchema });
export const loadCuratedSkillSchema = skillSelectionSchema.extend({ sessionId: sessionIdSchema });

const draftSchema = z.strictObject({
  skillId: skillIdSchema,
  description: summary,
  body: z.string().trim().min(1).max(12_000).transform((text) => text.replaceAll("\r\n", "\n")),
  owner: summary,
  lifecycle: note,
  verification: note,
});
const reuseReference = z.union([skillSelectionSchema, z.strictObject({ ownerReference: summary })]);
const decisionDetails = {
  findingKey: findingKeySchema,
  revision,
  sourceInspected: note,
  rationale: note,
};
export const decideProposalSchema = z.discriminatedUnion("decision", [
  z.strictObject({ ...decisionDetails, decision: z.literal("create"), draft: draftSchema }),
  z.strictObject({ ...decisionDetails, decision: z.literal("update"), draft: draftSchema, previousVersion: revision }),
  z.strictObject({
    ...decisionDetails, decision: z.literal("reuse"),
    reference: reuseReference,
  }),
  z.strictObject({ ...decisionDetails, decision: z.literal("reject") }),
]);

export const decideProposalInputSchema = z.strictObject({
  ...decisionDetails,
  decision: z.enum(["create", "update", "reuse", "reject"]),
  draft: draftSchema.optional(),
  previousVersion: revision.optional(),
  reference: reuseReference.optional(),
}).refine(
  (value) => decideProposalSchema.safeParse(value).success,
  "Create requires a draft. Update requires a draft and current version. Reuse requires a reference. Reject requires a rationale.",
);

export type SkillSelection = z.infer<typeof skillSelectionSchema>;
export interface PublishedSkill extends SkillSelection {
  markdown: string;
  digest: string;
}
type Proposal = z.infer<typeof proposedSkillSchema>;
type Draft = z.infer<typeof draftSchema>;
type Decision = z.infer<typeof decideProposalSchema>;
type Validator = (skill: PublishedSkill) => void | Promise<void>;
type Write = "inserted" | "duplicate";

export class SkillCurationError extends Error {
  constructor(readonly code: "forbidden" | "identity_conflict" | "invalid_skill" | "not_found" | "stale_review", message: string) {
    super(message);
  }
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const hostPath = /(?:\b[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|(?:^|[\s"'(])\/(?:home|Users|mnt|private|tmp|var\/log)\/)/im;
const credential = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~-]{24,})/i;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const privateSession = /\b(?:task|session|principal)_[A-Za-z0-9._-]+\b|\b(?:auth\.json|session\.jsonl)\b/i;

function render(draft: Draft, version: number): PublishedSkill {
  const text = draft.description + "\n" + draft.body;
  if (hostPath.test(text) || credential.test(text) || controls.test(text) || privateSession.test(text)) {
    throw new SkillCurationError("invalid_skill", "Use generic guidance without local paths, credentials or operational records.");
  }
  const markdown = [
    "---", "name: " + draft.skillId, "description: " + JSON.stringify(draft.description),
    "metadata:", "  version: " + JSON.stringify(String(version)), "---", "", draft.body, "",
  ].join("\n");
  return { skillId: draft.skillId, version, markdown, digest: hash(markdown) };
}

export class CuratedSkills {
  readonly #database: DatabaseSync;
  readonly #validate: Validator;

  constructor(options: { directory: string; validate: Validator }) {
    const directory = resolve(options.directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(join(directory, "skills.sqlite"), { timeout: 5_000 });
    this.#validate = options.validate;
    try {
      this.#database.exec(
        "CREATE TABLE IF NOT EXISTS skill_findings ("
        + "sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, finding_key TEXT NOT NULL,"
        + "task_id TEXT NOT NULL, payload TEXT NOT NULL, submitted_at TEXT NOT NULL) STRICT;"
        + "CREATE INDEX IF NOT EXISTS skill_findings_by_group ON skill_findings(finding_key, sequence);"
        + "CREATE TABLE IF NOT EXISTS skill_decisions ("
        + "finding_key TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, "
        + "curator TEXT NOT NULL, decided_at TEXT NOT NULL, PRIMARY KEY (finding_key, revision)) STRICT;"
        + "CREATE TABLE IF NOT EXISTS curated_skills ("
        + "skill_id TEXT NOT NULL, version INTEGER NOT NULL, finding_key TEXT NOT NULL, description TEXT NOT NULL,"
        + "markdown TEXT NOT NULL, digest TEXT NOT NULL, guidance_digest TEXT NOT NULL,"
        + "PRIMARY KEY (skill_id, version)) STRICT;"
        + "CREATE INDEX IF NOT EXISTS curated_skills_by_group ON curated_skills(finding_key);"
        + "CREATE INDEX IF NOT EXISTS curated_skills_by_guidance ON curated_skills(guidance_digest);",
      );
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    if (this.#database.isOpen) this.#database.close();
  }

  submit(proposal: Proposal, principalId: string, taskId: string): { write: Write; findingKey: string } {
    const id = hash(principalId + "\0" + proposal.submissionId);
    const payload = JSON.stringify({ ...proposal, principalId, taskId });
    return this.#write(() => {
      const previous = this.#database.prepare("SELECT payload FROM skill_findings WHERE id = ?").get(id);
      if (previous?.payload === payload) return { write: "duplicate", findingKey: proposal.findingKey };
      if (previous) throw new SkillCurationError("identity_conflict", "This submission ID already records a different finding.");
      this.#database.prepare(
        "INSERT INTO skill_findings (id, finding_key, task_id, payload, submitted_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, proposal.findingKey, taskId, payload, new Date().toISOString());
      return { write: "inserted", findingKey: proposal.findingKey };
    });
  }

  inspect(findingKey: string | undefined, taskIds: readonly string[], includeDecisions: boolean) {
    const tasks = JSON.stringify(taskIds);
    const groups = this.#database.prepare(
      "SELECT finding_key AS findingKey, MAX(sequence) AS revision, COUNT(*) AS total "
      + "FROM skill_findings WHERE task_id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR finding_key = ?) "
      + "GROUP BY finding_key ORDER BY revision DESC LIMIT 50",
    ).all(tasks, findingKey ?? null, findingKey ?? null);
    if (findingKey === undefined) return { groups };
    const group = groups[0];
    if (group === undefined) throw new SkillCurationError("not_found", "The scoped proposal group is unavailable.");
    if (includeDecisions) this.#groupAccess(findingKey, taskIds);
    const findings = this.#database.prepare(
      "SELECT payload, submitted_at FROM skill_findings WHERE finding_key = ? AND sequence <= ? "
      + "AND task_id IN (SELECT value FROM json_each(?)) ORDER BY sequence DESC LIMIT 50",
    ).all(findingKey, group.revision, tasks).map(({ payload, submitted_at }) => ({
      ...JSON.parse(String(payload)), submittedAt: submitted_at,
    }));
    const decisions = includeDecisions ? this.#database.prepare(
      "SELECT payload, curator, decided_at FROM skill_decisions "
      + "WHERE finding_key = ? AND revision <= ? ORDER BY revision DESC LIMIT 50",
    ).all(findingKey, group.revision).map(({ payload, curator, decided_at }) => ({
      ...JSON.parse(String(payload)), curator, decidedAt: decided_at,
    })) : [];
    return { group: { ...group, findings, decisions } };
  }

  catalog() {
    return this.#database.prepare(
      "SELECT skill_id AS skillId, MAX(version) AS version, description FROM curated_skills "
      + "GROUP BY skill_id ORDER BY skill_id LIMIT 100",
    ).all();
  }

  read({ skillId, version }: SkillSelection): PublishedSkill {
    const row = this.#database.prepare(
      "SELECT markdown, digest FROM curated_skills WHERE skill_id = ? AND version = ?",
    ).get(skillId, version);
    if (!row) throw new SkillCurationError("not_found", "The requested published skill version is unavailable.");
    const markdown = String(row.markdown);
    const digest = String(row.digest);
    if (hash(markdown) !== digest) throw new SkillCurationError("invalid_skill", "The published skill failed its integrity check.");
    return { skillId, version, markdown, digest };
  }

  review(findingKey: string, expected: number, taskIds: readonly string[], taskId: string): string {
    this.#currentGroup(findingKey, expected, taskIds);
    if (!this.#database.prepare("SELECT 1 FROM skill_findings WHERE finding_key = ? AND task_id = ?").get(findingKey, taskId)) {
      throw new SkillCurationError("forbidden", "The review task does not have a finding in this group.");
    }
    return "event_skill_review_" + hash(findingKey + "\0" + expected);
  }

  async decide(decision: Decision, curator: string, taskIds: readonly string[]) {
    const { findingKey, revision: expected } = decision;
    this.#groupAccess(findingKey, taskIds);
    const payload = JSON.stringify(decision);
    const publication = decision.decision === "create" || decision.decision === "update" ? render(
      decision.draft, decision.decision === "create" ? 1 : decision.previousVersion + 1,
    ) : undefined;
    if (publication) await this.#validate(publication);
    return this.#write(() => {
      this.#groupAccess(findingKey, taskIds);
      const existing = this.#database.prepare(
        "SELECT payload FROM skill_decisions WHERE finding_key = ? AND revision = ?",
      ).get(findingKey, expected);
      const skill = publication ? { skillId: publication.skillId, version: publication.version } : undefined;
      const receipt = { findingKey, revision: expected, decision: decision.decision, ...(skill && { skill }) };
      if (existing?.payload === payload) return { ...receipt, write: "duplicate" as const };
      if (existing) throw new SkillCurationError("identity_conflict", "This proposal revision has already been decided.");
      this.#currentGroup(findingKey, expected, taskIds);

      if (decision.decision === "create" || decision.decision === "update") {
        this.#publish(decision, publication!);
      } else if (decision.decision === "reuse" && "skillId" in decision.reference) {
        this.read(decision.reference);
      }
      this.#database.prepare(
        "INSERT INTO skill_decisions (finding_key, revision, payload, curator, decided_at) VALUES (?, ?, ?, ?, ?)",
      ).run(findingKey, expected, payload, curator, new Date().toISOString());
      return { ...receipt, write: "inserted" as const };
    });
  }

  #publish(decision: Extract<Decision, { decision: "create" | "update" }>, skill: PublishedSkill): void {
    const guidanceDigest = hash(decision.draft.description + "\0" + decision.draft.body);
    const previous = this.#database.prepare(
      "SELECT version, guidance_digest FROM curated_skills WHERE skill_id = ? ORDER BY version DESC LIMIT 1",
    ).get(skill.skillId);
    const duplicate = this.#database.prepare(
      "SELECT 1 FROM curated_skills WHERE guidance_digest = ? AND skill_id <> ?",
    ).get(guidanceDigest, skill.skillId);
    if (duplicate) throw new SkillCurationError("invalid_skill", "This guidance already has a published owner.");
    if (decision.decision === "create") {
      const knownGroup = this.#database.prepare("SELECT 1 FROM curated_skills WHERE finding_key = ?").get(decision.findingKey);
      if (previous || knownGroup) {
        throw new SkillCurationError("identity_conflict", "Use the existing skill or update its most recent version.");
      }
    } else {
      if (previous?.version !== decision.previousVersion) {
        throw new SkillCurationError("stale_review", "The current published skill version has changed.");
      }
      if (previous.guidance_digest === guidanceDigest) {
        throw new SkillCurationError("invalid_skill", "Reuse the current version when the guidance has no changes.");
      }
    }
    this.#database.prepare(
      "INSERT INTO curated_skills (skill_id, version, finding_key, description, markdown, digest, guidance_digest) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(skill.skillId, skill.version, decision.findingKey, decision.draft.description, skill.markdown, skill.digest, guidanceDigest);
  }

  #groupAccess(findingKey: string, taskIds: readonly string[]): number {
    const row = this.#database.prepare(
      "SELECT MAX(sequence) AS revision, COUNT(*) AS total, "
      + "SUM(task_id IN (SELECT value FROM json_each(?))) AS visible FROM skill_findings WHERE finding_key = ?",
    ).get(JSON.stringify(taskIds), findingKey);
    if (!row?.total) throw new SkillCurationError("not_found", "The proposal group is unavailable.");
    if (row.visible !== row.total) throw new SkillCurationError("forbidden", "The proposal group is outside the curator's current task scope.");
    return Number(row.revision);
  }

  #currentGroup(findingKey: string, expected: number, taskIds: readonly string[]): void {
    if (this.#groupAccess(findingKey, taskIds) !== expected || this.#database.prepare(
      "SELECT 1 FROM skill_decisions WHERE finding_key = ? AND revision = ?",
    ).get(findingKey, expected)) {
      throw new SkillCurationError("stale_review", "The proposal group has changed. Inspect its current evidence before reviewing.");
    }
  }

  #write<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
