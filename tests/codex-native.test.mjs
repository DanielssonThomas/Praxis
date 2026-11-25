import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexExecutor } from "@praxis/codex-runtime";
import { CodexRun } from "../packages/codex-runtime/dist/native.js";

async function program(t, text) {
  const workspace = await mkdtemp(join(tmpdir(), "praxis-codex-process-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const binary = join(workspace, "fixture.mjs");
  await writeFile(binary, "#!/usr/bin/env node\n" + text, { mode: 0o700 });
  return { program: binary, workspace, home: workspace, userHome: workspace, environment: { PATH: process.env.PATH } };
}

test("native launch fails closed for an unsupported observed Codex version", { skip: process.platform !== "linux" }, async (t) => {
  const profile = await program(t, 'console.log("codex-cli 0.171.0");');
  const executor = new CodexExecutor({ program: profile.program, axiomRoot: profile.workspace, root: profile.workspace, model: "fixture" });
  const capabilities = await executor.capabilities();
  assert.equal(capabilities.host.version, "0.171.0");
  assert.ok(["launch", "output", "cancellation", "completion"].every((key) => !capabilities[key].available));
});

test("native output stays inspectable but an exit without a terminal receipt cannot pass", { skip: process.platform !== "linux" }, async (t) => {
  const profile = await program(t, `process.stdin.resume(); console.log(JSON.stringify({ type: "item.completed",
    item: { type: "agent_message", text: "Visible prior to confirmed completion" } }));
    process.stdin.on("end", () => process.exit(0));`);
  const run = new CodexRun(profile, "fixture", "Local test", 5_000);
  await run.started;
  await run.finished;
  assert.equal(run.status, "failed");
  assert.deepEqual(run.output, { availability: "available", text: "Visible prior to confirmed completion", truncated: false });
  assert.equal(run.usage, undefined);
});

test("a running native process must settle after its deadline", { skip: process.platform !== "linux" }, async (t) => {
  const profile = await program(t, "setInterval(() => {}, 1000);");
  const run = new CodexRun(profile, "fixture", "Local test", 150);
  await run.started;
  await run.finished;
  assert.equal(run.status, "interrupted");
  assert.equal(run.usage, undefined);
});

test("an oversized JSONL record terminates the bounded native process", { skip: process.platform !== "linux" }, async (t) => {
  const profile = await program(t, 'process.stdout.write("q".repeat(9 * 1024 * 1024)); setInterval(() => {}, 1000);');
  const run = new CodexRun(profile, "fixture", "Local test", 5_000);
  await run.started;
  await run.finished;
  assert.equal(run.status, "failed");
  assert.equal(run.output.availability, "unavailable");
});
