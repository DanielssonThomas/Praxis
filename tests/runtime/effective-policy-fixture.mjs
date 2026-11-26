import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { CodexExecutor } from "@praxis/codex-runtime";
import { EffectivePolicyService } from "@praxis/management";

const execute = promisify(execFile);
const initial = "before scoped worker\n";
const delivered = "after scoped worker\n";
const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

export async function exerciseEffectivePolicy(t, { directory, store, task, intent, grant, axiomRoot, policyDigest }) {
  const program = process.env.PRAXIS_CODEX_BIN;
  assert.ok(program, "Set PRAXIS_CODEX_BIN to bin/codex from the complete pinned distribution.");
  const root = join(directory, "integrated");
  const file = "src/fixture.txt";
  const checkFile = "checks/accept.mjs";
  const session = { schemaVersion: 1, id: "session_effective_policy_native", taskId: task.id };
  const reviewerId = "principal_effective_policy_operator";
  const brief = {
    id: task.id,
    objective: "Replace the one line in the disposable fixture and report the change.",
    ownedPaths: [file],
    policy: { version: "1", digest: policyDigest, profiles: [] },
    criteria: [{ id: "exact-change", description: "Run the protected acceptance command on the integrated fixture.", required: true }],
    requiredCapabilities: ["process-execution", "policy-loading"],
    limits: { timeoutMs: 25_000, maxAttempts: 1, maxConcurrency: 1 },
  };
  const requirements = [{ id: "fixture-check", criterionId: "exact-change", kind: "automated",
    command: { docs: [{ path: "README.md", heading: "Verification" }] },
  }];
  const check = `import { readFileSync } from "node:fs";\nprocess.exitCode = readFileSync(${JSON.stringify(file)}, "utf8") === ${JSON.stringify(delivered)} ? 0 : 1;\n`;
  await Promise.all([mkdir(join(root, "src"), { recursive: true }), mkdir(join(root, "checks"), { recursive: true })]);
  await Promise.all([
    writeFile(join(root, file), initial),
    writeFile(join(root, checkFile), check),
    writeFile(join(root, "README.md"), "# Fixture\n\n## Verification\n\n```sh\nnode checks/accept.mjs\n```\n"),
  ]);
  const git = (...args) => execute("git", args, { cwd: root, timeout: 10_000 });
  await git("init", "-q");
  await git("add", ".");
  await git("-c", "user.name=Praxis Fixture", "-c", "user.email=praxis-fixture@example.invalid", "commit", "-qm", "Admission baseline");
  store.recordSession(session);

  let grants = [grant];
  const options = {
    store, axiomRoot, evidenceRoot: join(directory, "policy-evidence"),
    loadGrants: async () => grants,
    loadAuthority: async (id) => id === task.id ? {
      revision: 1, root, brief, requirements, protectedPaths: [checkFile], reviewerId,
      verificationHost: { agent: "praxis", version: process.version, model: "scripted-local", os: `${process.platform}-${process.arch}`, surface: "cli" },
    } : undefined,
  };
  const service = await EffectivePolicyService.open(options);
  assert.equal(intent?.details?.action?.kind, "task.delegate");
  const preview = await service.preview(intent.id, session.id);
  assert.deepEqual(preview.request.brief, brief);
  const admitted = await service.admit(intent.id, session.id, preview.fingerprint);
  assert.equal(admitted.write, "inserted");
  assert.deepEqual(await service.admit(intent.id, session.id, preview.fingerprint), { ...admitted, write: "duplicate" });

  let deliveredBrief;
  let error;
  const toolId = "edit-disposable-fixture";
  const marker = "Native scoped edit delivered";
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/responses");
      assert.equal(request.headers.authorization, undefined);
      const chunks = [];
      for await (const bytes of request) chunks.push(bytes);
      const body = JSON.parse(Buffer.concat(chunks));
      const result = body.input.find(({ type, call_id }) => type === "custom_tool_call_output" && call_id === toolId);
      const id = result ? "response-complete" : "response-edit";
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(frame({ type: "response.created", response: { id } }));
      if (result) {
        assert.ok(JSON.stringify(result.output).includes(marker));
        const item = { id: "message-native", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: marker, annotations: [] }],
        };
        response.write(frame({ type: "response.output_item.added", item: { ...item, content: [], status: "in_progress" } }));
        response.write(frame({ type: "response.output_text.delta", delta: marker, item_id: item.id, output_index: 0, content_index: 0 }));
        response.write(frame({ type: "response.output_item.done", item }));
      } else {
        const user = body.input.filter(({ type, role }) => type === "message" && role === "user")
          .flatMap(({ content }) => content).map(({ text }) => text);
        const prompt = user.at(-1);
        deliveredBrief = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
        assert.deepEqual(deliveredBrief, brief);
        assert.ok(user.slice(0, -1).some((text) => text.includes(`Axiom policy digest: ${policyDigest}`)));
        assert.ok(body.tools.some(({ name }) => name === "exec"));
        const item = { type: "custom_tool_call", call_id: toolId, name: "exec", input: `
          const result = await tools.exec_command({ cmd: "printf 'after scoped worker\\n' > src/fixture.txt" });
          if (result.exit_code !== 0) throw new Error("Scoped edit failed.");
          text(${JSON.stringify(marker)});
        ` };
        response.write(frame({ type: "response.output_item.done", item }));
      }
      response.end(frame({ type: "response.completed", response: { id, status: "completed",
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      } }));
    } catch (cause) {
      error = cause;
      response.end();
    }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  try {
    const executor = new CodexExecutor({
      program, axiomRoot, root: join(directory, "policy-workers"), model: "gpt-5.4",
      prepareWorkspace: async ({ workspace }) => {
        await git("clone", "-q", "--no-hardlinks", root, workspace);
        assert.equal(await service.verifyStaging(admitted.admissionId, workspace), "inserted");
      },
      prepareProfile: ({ codexHome }) => writeFile(join(codexHome, "config.toml"), [
        'model_provider = "fixture"', "[features]", "code_mode_only = true", "[code_mode]", "disable_in_process_fallback = true",
        "[model_providers.fixture]", 'name = "Disposable local fixture"',
        `base_url = "http://127.0.0.1:${provider.address().port}/v1"`, 'wire_api = "responses"',
        "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 0",
      ].join("\n")),
    });
    assert.deepEqual((await executor.capabilities()).host, {
      runtime: "codex", os: "linux", architecture: "x64", version: "0.172.0-alpha.2", surface: "cli",
    });
    const assignment = await executor.createAssignment(admitted.request);
    assert.equal(await service.recordLaunch(admitted.admissionId, assignment), "inserted");
    const observation = await executor.waitAssignment(assignment);
    if (error) throw error;
    assert.equal(observation.snapshot.status, "completed");
    assert.deepEqual(deliveredBrief, brief);
    assert.match(observation.snapshot.output.text, /Native scoped edit delivered/);
    const workerRoot = executor.workspaceFor(assignment);
    assert.equal(await readFile(join(workerRoot, file), "utf8"), delivered);
    assert.equal(await readFile(join(root, file), "utf8"), initial);
    const result = { admissionId: admitted.admissionId, assignment, observation, workerRoot };
    assert.equal(service.recordSettlement(admitted.admissionId, assignment, observation), "inserted");

    const failed = await service.verify(admitted.admissionId);
    assert.equal(failed.report.checks[0].outcome.status, "failed");
    await assert.rejects(service.inspectIntegration(result), { code: "stale" });
    await copyFile(join(workerRoot, file), join(root, file));
    const integrated = await service.inspectIntegration(result);
    const review = { reviewerId, sourceDigest: integrated.source.digest, receiptDigest: integrated.receiptDigest };

    const stale = await service.complete({ ...result, review, verification: failed });
    assert.equal(stale.verification.checks[0].outcome.status, "blocked");
    const notRun = await service.verify(admitted.admissionId, { signal: AbortSignal.abort() });
    assert.equal((await service.complete({ ...result, review, verification: notRun })).verification.checks[0].outcome.status, "not_run");

    await writeFile(join(root, checkFile), "process.exitCode = 0;\n");
    await assert.rejects(service.verify(admitted.admissionId), { code: "stale" });
    await writeFile(join(root, checkFile), check);
    const verified = await service.verify(admitted.admissionId);
    assert.equal(verified.report.checks[0].outcome.status, "passed");
    await assert.rejects(service.complete({ ...result, review: { ...review, reviewerId: grant.principalId }, verification: verified }), { code: "forbidden" });
    grants = [{ ...grant, actionKinds: [] }];
    await assert.rejects(service.complete({ ...result, review, verification: verified }), { code: "forbidden" });
    grants = [grant];
    assert.equal(store.eventsOfKind("task.completed").length, 0);
    const reopened = await EffectivePolicyService.open(options);
    assert.equal(reopened.readAdmission(intent.id).assignment.runId, assignment.runId);
    assert.equal((await reopened.complete({ ...result, review, verification: verified })).write, "inserted");
    assert.equal((await service.complete({ ...result, review, verification: verified })).write, "duplicate");
    assert.equal(store.eventsOfKind("task.completed").length, 1);
    t.diagnostic("Native Hermes MCP delegation reached pinned Codex, which received the exact brief and made an isolated workspace edit. Observed failed, stale, unrun and revoked completion were denied. Fresh verified integration completed once.");
  } finally {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
}
