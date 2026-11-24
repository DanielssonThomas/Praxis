import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { runtimeSessionSnapshotSchema } from "@praxis/contracts";
import { HermesRuntime } from "@praxis/hermes-runtime";
import { chromium } from "playwright";
import { startHermesFixture, startShell, stopProcess, until } from "./hermes-fixture.mjs";

const execute = promisify(execFile);
const holdPrompt = "Wait for the isolated Praxis runtime fixture.";
const finalOutput = "Hermes completed the isolated Praxis fixture.";

async function waitForState(runtime, assignment, expected) {
  return until(async () => {
    const observed = await runtime.inspectAssignment(assignment);
    return observed.status === expected ? observed : false;
  }, `Hermes never reached ${expected}`);
}

test("real Hermes runs survive closing Praxis and can be inspected and stopped after reopening", { timeout: 120_000 }, async (t) => {
  let holdCalls = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  t.after(release);
  const { origin, apiKey, runtime, directory } = await startHermesFixture(t, async (call) => {
    if (call.messages.some(({ content }) => JSON.stringify(content)?.includes(holdPrompt))) {
      holdCalls += 1;
      await hold;
    }
    return { message: { role: "assistant", content: finalOutput } };
  });

  let browser;
  let shell;
  t.after(async () => {
    await browser?.close();
    await stopProcess(shell?.processHandle);
  });

  await assert.rejects(new HermesRuntime({ origin, apiKey: "invalid-fixture-key" }).capabilities(), { code: "unauthorized" });

  browser = await chromium.launch({ executablePath: process.env.PRAXIS_TEST_CHROMIUM });
  shell = await startShell(directory);
  const firstPage = await browser.newPage();
  await firstPage.goto(shell.origin);
  await firstPage.getByRole("heading", { name: "Manager" }).waitFor();

  const session = { schemaVersion: 1, id: "session_fixture1", taskId: "task_fixture1" };
  const submit = `
    import { HermesRuntime } from "@praxis/hermes-runtime";
    const [origin, session, prompt] = process.argv.slice(1);
    const runtime = new HermesRuntime({ origin, apiKey: process.env.PRAXIS_FIXTURE_KEY });
    process.stdout.write(JSON.stringify(await runtime.createAssignment(JSON.parse(session), prompt)));
  `;
  const child = await execute(process.execPath, [
    "--input-type=module", "--eval", submit, origin, JSON.stringify(session), holdPrompt,
  ], { env: { ...process.env, PRAXIS_FIXTURE_KEY: apiKey }, timeout: 20_000 });
  const assignment = JSON.parse(child.stdout);
  await until(() => holdCalls > 0, "The native run did not invoke the loopback provider");
  const active = await waitForState(runtime, assignment, "running");
  assert.deepEqual(runtimeSessionSnapshotSchema.parse(active), active);
  assert.equal(active.output.availability, "unavailable");

  await firstPage.close();
  await stopProcess(shell.processHandle);
  shell = await startShell(directory);
  const secondPage = await browser.newPage();
  await secondPage.goto(shell.origin);
  await secondPage.getByRole("heading", { name: "Manager" }).waitFor();

  const reconnected = new HermesRuntime({ origin, apiKey });
  assert.equal((await reconnected.inspectAssignment(assignment)).status, "running");
  assert.equal((await reconnected.createAssignment(session, holdPrompt)).runId, assignment.runId);
  assert.equal(holdCalls, 1);
  assert.equal((await reconnected.stopAssignment(assignment)).status, "stopping");
  release();
  await waitForState(reconnected, assignment, "stopped");

  const completedAssignment = await reconnected.createAssignment({
    schemaVersion: 1, id: "session_fixture2", taskId: "task_fixture2",
  }, "Complete the isolated Praxis fixture.");
  const completed = await waitForState(reconnected, completedAssignment, "completed");
  assert.deepEqual(completed.output, { availability: "available", text: finalOutput, truncated: false });
  t.diagnostic("Native bearer check, idempotent create, Praxis browser and UI host restart, exact stop and terminal output passed.");
});
