import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { CodexExecutor } from "@praxis/codex-runtime";

test("an explicitly authorized Codex account completes one real scoped worker assignment", { timeout: 125_000 }, async (t) => {
  assert.equal(process.env.PRAXIS_RUN_CODEX_ACCOUNT, "1", "Explicit real-account opt-in is required.");
  const { PRAXIS_CODEX_BIN: program, PRAXIS_AXIOM_ROOT: axiomRoot, PRAXIS_CODEX_ACCOUNT_HOME: accountHome,
    PRAXIS_CODEX_MODEL: model } = process.env;
  assert.ok(program && isAbsolute(program) && axiomRoot && isAbsolute(axiomRoot) && accountHome && isAbsolute(accountHome) && model,
    "Supply an absolute Codex binary, Axiom checkout and account home, plus the account's entitled model.");
  const auth = join(accountHome, "auth.json");
  const login = await access(auth, constants.R_OK).then(() => stat(auth)).catch(() => undefined);
  assert.ok(login?.isFile() && login.size > 0,
    "Complete file-based Codex login in the selected dedicated home so a readable auth.json exists.");
  const root = await mkdtemp(join(tmpdir(), "praxis-codex-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = "native-fixture-" + randomUUID();
  const task = { schemaVersion: 1, id: "task_account_fixture", title: "Read the authorized fixture" };
  const session = { schemaVersion: 1, id: "session_account_fixture", taskId: task.id };
  const executor = new CodexExecutor({
    program, axiomRoot, root, model,
    async prepareProfile({ codexHome }) {
      const stagedAuth = join(codexHome, "auth.json");
      try {
        await copyFile(auth, stagedAuth);
        await chmod(stagedAuth, 0o600);
      } catch {
        throw new Error("The dedicated Codex login could not be staged.");
      }
      await copyFile(join(accountHome, "config.toml"), join(codexHome, "config.toml")).catch((error) => {
        if (error.code !== "ENOENT") throw new Error("The dedicated Codex configuration could not be staged.");
      });
    },
    prepareWorkspace: ({ workspace }) => writeFile(join(workspace, "fixture.txt"), marker + "\n"),
  });
  const caps = await executor.capabilities();
  assert.ok(caps.launch.available, "The configured pinned Codex CLI must be available.");
  const assignment = await executor.createAssignment({
    task, session,
    brief: {
      id: task.id, objective: "Read fixture.txt and respond with its sole line verbatim. Leave every file unchanged.",
      ownedPaths: ["fixture.txt"],
      policy: { version: "1", digest: "sha256:2e968204a73b3d6384af8ff0687c8126c3ef798725f4d566ccbf655151ebcc78", profiles: [] },
      criteria: [{ id: "read-fixture", description: "Return the exact file contents and preserve the isolated workspace.", required: true }],
      requiredCapabilities: ["process-execution", "policy-loading", "completion"],
      limits: { timeoutMs: 110_000, maxAttempts: 1, maxConcurrency: 1 },
    },
  });
  const run = await executor.waitAssignment(assignment);
  assert.equal(run.snapshot.status, "completed", "The authorized account did not issue a completed native turn.");
  assert.equal(run.snapshot.output.availability, "available");
  assert.ok(run.snapshot.output.text.includes(marker), "The actual native completion did not return the workspace fixture.");
  const workspace = executor.workspaceFor(assignment);
  assert.deepEqual(await readdir(workspace), ["fixture.txt"]);
  assert.equal(await readFile(join(workspace, "fixture.txt"), "utf8"), marker + "\n");
  t.diagnostic(JSON.stringify({ host: caps.host, model, status: run.snapshot.status, metering: run.usage.metering }));
});
