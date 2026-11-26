import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { createPraxisMcpServer } from "@praxis/mcp";
import { defaultSettings } from "@praxis/settings";
import { OperationalStore } from "@praxis/state";
import { desktopPackageRoot, enter, eventually, startDesktop } from "./desktop-fixture.mjs";
import { scriptedUsage, startPackagedCodexProvider } from "./desktop-codex-provider.mjs";
import { startNamedHermesFixture } from "./named-hermes-fixture.mjs";

const profile = "praxis-codex-fixture-manager";
const target = "src/fixture.txt";
const guard = "checks/accept.mjs";
const policy = { version: "1", profiles: [],
  digest: "sha256:2e968204a73b3d6384af8ff0687c8126c3ef798725f4d566ccbf655151ebcc78" };
const criterion = "exact-fixture";
const toolName = "mcp__praxis__request_action";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const credential = () => randomBytes(32).toString("base64url");
const reply = (content) => ({ message: { role: "assistant", content } });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function toolReply(body, args) {
  const direct = body.tools?.some(({ function: fn }) => fn?.name === toolName);
  return { finishReason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
    id: "call_" + args.submissionId, type: "function", function: {
      name: direct ? toolName : "tool_call",
      arguments: JSON.stringify(direct ? args : { calls: [{ name: toolName, arguments: args }] }),
    },
  }] } };
}

function entry(key) {
  const task = { schemaVersion: 1, id: "task_packaged_" + key, title: "Disposable " + key + " assignment" };
  return {
    task, session: { schemaVersion: 1, id: "session_packaged_" + key, taskId: task.id },
    submissionId: "event_packaged_" + key, prompt: "Request the " + key + " fixture assignment.",
  };
}

async function enrollment(directory, item, { initial, delivered, marker }) {
  const root = join(directory, item.task.id);
  await Promise.all([mkdir(join(root, "src"), { recursive: true }), mkdir(join(root, "checks"), { recursive: true })]);
  const verification = 'import { readFileSync } from "node:fs";\n'
    + "process.exitCode = readFileSync(" + JSON.stringify(target) + ', "utf8") === '
    + JSON.stringify(delivered) + " ? 0 : 1;\n";
  const fence = String.fromCharCode(96).repeat(3);
  const readme = ["# Disposable integration fixture", "", "## Verification", "", fence + "sh", "node checks/accept.mjs", fence, ""].join("\n");
  await Promise.all([
    writeFile(join(root, target), initial), writeFile(join(root, guard), verification), writeFile(join(root, "README.md"), readme),
  ]);
  git(root, "init", "--quiet");
  git(root, "add", ".");
  git(root, "-c", "user.name=Praxis Fixture", "-c", "user.email=praxis-fixture@example.invalid", "commit", "--quiet", "-m", "Enrolled source");
  const brief = {
    id: item.task.id, policy, ownedPaths: [target],
    objective: "Edit only " + target + ". Replace its sole line with " + JSON.stringify(delivered.trimEnd())
      + " and a final newline. Use native workspace tools to make the edit. Then report " + JSON.stringify(marker)
      + " verbatim. Preserve all other files.",
    requiredCapabilities: ["process-execution", "policy-loading", "completion"],
    criteria: [{ id: criterion, description: "The protected command confirms the exact scoped edit.", required: true }],
    limits: { timeoutMs: 110_000, maxAttempts: 1, maxConcurrency: 1 },
  };
  return {
    taskId: item.task.id, sessionId: item.session.id, sourceRevision: git(root, "rev-parse", "HEAD"),
    authority: {
      revision: 1, root, brief,
      requirements: [{ id: "packaged-fixture-check", criterionId: criterion, kind: "automated",
        command: { docs: [{ path: "README.md", heading: "Verification" }] } }],
      protectedPaths: [guard], reviewerId: "principal_packaged_operator",
      verificationHost: { agent: "praxis", version: process.version, model: "trusted-fixture",
        os: process.platform + "-" + process.arch, surface: "cli" },
    },
  };
}

async function bundledReview(host, environment, token, ...args) {
  const child = spawn(join(host, "bin/node"), [join(host, "app/dist/codex-delegation-runner.js"), ...args], {
    cwd: host, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
    stdio: ["pipe", "pipe", "ignore"], signal: AbortSignal.timeout(20_000),
  });
  child.stdin.on("error", () => {});
  child.stdin.end(token + "\n");
  const chunks = [];
  child.stdout.on("data", (bytes) => chunks.push(bytes));
  const [code] = await once(child, "close");
  return code === 0 ? { code, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) } : { code };
}

test("packaged Manager approves one bounded Codex edit and restores its verified native result", { timeout: 240_000 }, async (t) => {
  const {
    PRAXIS_DESKTOP_DEB: packagePath, PRAXIS_CODEX_BIN: program, PRAXIS_AXIOM_ROOT: axiomRoot,
    PRAXIS_CODEX_ACCOUNT_HOME: accountHome, PRAXIS_CODEX_MODEL: accountModel,
  } = process.env;
  const account = process.env.PRAXIS_RUN_CODEX_ACCOUNT === "1";
  assert.ok([packagePath, program, axiomRoot].every((path) => path && isAbsolute(path)),
    "Set absolute package, complete Codex distribution and built Axiom paths.");
  if (account) {
    assert.ok(accountHome && isAbsolute(accountHome) && accountModel, "Set the dedicated Codex account home and entitled model.");
    const login = join(accountHome, "auth.json");
    const readable = await access(login, constants.R_OK).then(() => stat(login)).catch(() => undefined);
    assert.ok(readable?.isFile() && readable.size > 0, "Complete file-based native login in the dedicated local account profile.");
  }

  const directory = await mkdtemp(join(tmpdir(), "praxis-desktop-codex-"));
  const database = join(directory, "state.sqlite");
  const store = new OperationalStore(database);
  let desktop;
  let mcp;
  let provider;
  t.after(async () => {
    provider?.finish();
    await desktop?.close();
    if (mcp?.listening) {
      mcp.closeAllConnections();
      await new Promise((resolve) => mcp.close(resolve));
    }
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const installed = desktopPackageRoot(packagePath, directory);
  const host = join(installed, "usr/lib/Praxis/host");
  const release = execFileSync(program, ["--version"], { encoding: "utf8" }).trim();
  assert.equal(release, "codex-cli 0.172.0-alpha.2");
  assert.equal(process.platform + "-" + process.arch, "linux-x64");

  const accepted = entry("allowed");
  const denied = entry("denied");
  const stale = entry("stale");
  const foreign = entry("foreign");
  // The authorized account lane offers exactly one Manager request and one approval.
  const assignments = account ? [accepted] : [accepted, denied, stale, foreign];
  const marker = "packaged-codex-fixture-" + randomUUID();
  const initial = "before the scoped fixture\n";
  const delivered = "after the scoped fixture " + marker + "\n";
  const enrollmentRows = await Promise.all(assignments.map((item) => enrollment(directory, item, { initial, delivered, marker })));
  const enrolled = enrollmentRows[0];
  const profileRoot = account ? accountHome : join(directory, "codex-profile");
  if (!account) {
    await mkdir(profileRoot, { mode: 0o700 });
    provider = await startPackagedCodexProvider(t, {
      brief: enrolled.authority.brief, file: target, initial, delivered, marker, profileRoot,
    });
  }
  for (const { task, session } of assignments) {
    store.recordTask(task);
    store.recordSession(session);
  }
  const mcpToken = credential();
  const operator = credential();
  const permitted = assignments.filter((item) => item !== foreign);
  const grant = {
    principalId: "principal_packaged_manager", tokenDigest: digest(mcpToken),
    taskIds: permitted.map(({ task }) => task.id),
    sessions: permitted.map(({ session }) => ({ sessionId: session.id, canReport: false })),
    actionKinds: ["task.delegate"],
  };
  mcp = createPraxisMcpServer({ store, grants: [grant] }).listen(0, "127.0.0.1");
  await once(mcp, "listening");
  const mcpOrigin = "http://127.0.0.1:" + mcp.address().port + "/mcp";
  const occurredAt = new Date().toISOString();
  const replayPrompt = "Repeat the original allowed fixture request.";
  const prompts = new Map(assignments.map((item) => [item.prompt, item]));
  if (!account) prompts.set(replayPrompt, accepted);
  const gateway = await startNamedHermesFixture(t, profile, (body) => {
    if (!body.tools?.length) return reply("Fixture auxiliary response.");
    const index = body.messages.findLastIndex(({ role }) => role === "user");
    const prompt = body.messages[index]?.content;
    const item = prompts.get(prompt);
    if (!item) return reply("Fixture manager response.");
    const tool = body.messages.slice(index + 1).findLast(({ role }) => role === "tool");
    const args = { submissionId: item.submissionId, occurredAt, kind: "task.delegate",
      target: { kind: "task", id: item.task.id } };
    if (!tool) return toolReply(body, args);
    const output = JSON.stringify(tool.content);
    if (output.includes("forbidden")) return reply("The fixture request was outside the Manager scope.");
    if (output.includes("pending")) return reply(prompt === replayPrompt ? "The original request was replayed." : "Pending fixture " + item.task.id);
    return reply("The fixture request received an unexpected response.");
  }, { mcpOrigin, mcpToken });

  const authority = join(directory, "authority.json");
  const settings = join(directory, "settings.json");
  const config = join(directory, "codex-delegation.json");
  const configuration = {
    schemaVersion: 1, program, axiomRoot, workerRoot: join(directory, "native-workers"), evidenceRoot: join(directory, "evidence"),
    profile: { root: profileRoot, authentication: account ? "file" : "none", model: account ? accountModel : "gpt-5.4" },
    assignments: enrollmentRows,
  };
  const saveConfig = () => writeFile(config, JSON.stringify(configuration), { mode: 0o600 });
  await writeFile(authority, JSON.stringify({ schemaVersion: 1, database, grants: [grant] }), { mode: 0o600 });
  const defaults = defaultSettings();
  await writeFile(settings, JSON.stringify({ ...defaults, manager: { ...defaults.manager, profile } }), { mode: 0o600 });
  await saveConfig();
  const network = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];
  const environment = {
    ...(account && Object.fromEntries(network.filter((key) => process.env[key]).map((key) => [key, process.env[key]]))),
    PRAXIS_CONFIG_FILE: settings, PRAXIS_MCP_CONFIG_FILE: authority, PRAXIS_CODEX_DELEGATION_FILE: config,
    PRAXIS_HERMES_ORIGIN: gateway.origin, PRAXIS_HERMES_API_KEY: gateway.apiKey,
    PRAXIS_OPERATOR_TOKEN_DIGEST: digest(operator), PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID: grant.principalId,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), XDG_CACHE_HOME: join(directory, "cache"),
  };
  const open = async () => {
    desktop = await startDesktop(join(installed, "usr/bin/praxis-desktop"), { environment });
    assert.equal((await desktop.handles()).length, 1);
    await desktop.waitForText("praxis-host-launch [role=status]", "Local Praxis host ready.");
  };
  const click = async (selector) => (await desktop.element(selector)).click();
  const shows = (selector, text) => eventually(() => desktop.execute(
    "return !!document.querySelector(arguments[0])?.textContent.includes(arguments[1]);", selector, text,
  ), "Expected visible fixture content was absent at " + selector);
  const unlock = async (form) => {
    const selector = 'form[aria-label="' + form + '"]';
    await (await desktop.element(selector + " input[type=password]")).type(operator);
    await click(selector + " button[type=submit]");
  };
  const command = async (value) => {
    const field = await desktop.element('[aria-label="Command"]');
    await field.click();
    await field.clear();
    await field.type(value + enter);
  };
  const confirmManager = async (item, prompt = item.prompt, expected = "Pending fixture " + item.task.id) => {
    await command(prompt);
    await shows('[role="log"]', expected);
    await eventually(() => desktop.execute(
      "return document.querySelector('praxis-manager .connection [role=status]')?.textContent.trim() === '';",
    ), "The visible Manager turn did not settle.");
    return store.eventsOfKind("action.requested").find(({ details }) => details?.type === "action_request"
      && details.action.kind === "task.delegate" && details.action.target.id === item.task.id);
  };

  const dialog = 'dialog[aria-labelledby="activity-review-title"][open]';
  const toggle = "#activity-toggle";
  const cardFor = (intent) => 'article[data-request-id="' + intent.id + '"]';
  const phase = (intent, name) => store.eventsOfKind("action." + name)
    .find(({ details }) => details.requestId === intent.id)?.details.transition.value;
  const openReview = async (item, intent, needsUnlock = false) => {
    assert.equal(intent?.details.actorId, grant.principalId);
    await click(toggle);
    if (needsUnlock) await unlock("Unlock activity");
    const card = cardFor(intent);
    await click(card + ' [data-action="inspect"]');
    await eventually(() => phase(intent, "evaluation"), "The exact request was not evaluated.");
    assert.equal(phase(intent, "evaluation").mode, "approval",
      "The packaged Activity must open an exact Codex delegation approval for the native Manager request.");
    await click(card + ' [data-action="review"]');
    await shows(dialog, "Delegate task to Codex");
    await shows(dialog, item.task.id);
    await shows(dialog, grant.principalId);
  };
  const closeReview = async () => {
    await click(dialog + ' button[aria-label="Close review"]');
    await eventually(() => desktop.execute("return !document.querySelector(arguments[0]);", dialog), "The Activity review is still open.");
    await click(toggle);
  };
  const attempts = () => store.eventsOfKind("task.delegation_launched");

  await open();
  await desktop.waitForText("h1", "Manager");
  await unlock("Open Manager");
  await desktop.waitForText("#manager-lock", "Lock manager");
  if (!account) {
    assert.equal(await confirmManager(foreign, foreign.prompt, "The fixture request was outside the Manager scope."), undefined);
    const refusal = await confirmManager(denied);
    await openReview(denied, refusal, true);
    await click(dialog + ' [data-action="deny"]');
    await shows(dialog, "Denied");
    assert.equal(phase(refusal, "decision").kind, "deny");
    await closeReview();
    const staleIntent = await confirmManager(stale);
    await openReview(stale, staleIntent);
    configuration.assignments.find(({ taskId }) => taskId === stale.task.id).authority.revision++;
    await saveConfig();
    await click(dialog + ' [data-action="approve"]');
    await eventually(() => phase(staleIntent, "decision")?.kind === "invalidated", "Changed authority did not invalidate the approval.");
    await closeReview();
    assert.equal(attempts().length, 0);
    provider.assertLaunches(0);
  }

  const intent = await confirmManager(accepted);
  await openReview(accepted, intent, account);
  assert.equal(attempts().length, 0);
  await click(dialog + ' [data-action="approve"]');
  const event = await eventually(() => attempts()[0], "The authorized Codex worker did not launch.", 60_000);
  assert.equal(attempts().length, 1);
  const assignment = event.details.assignment;
  assert.deepEqual({ taskId: assignment.taskId, sessionId: assignment.sessionId, runtime: assignment.runtime },
    { taskId: accepted.task.id, sessionId: accepted.session.id, runtime: "codex" });
  assert.equal(phase(intent, "decision").kind, "approve");
  await shows(dialog, "Codex reported the run as");
  await closeReview();

  const pane = '.session-pane[data-session-id="' + accepted.session.id + '"][data-worker-runtime="codex"]';
  const openOverview = async (unlockRequired) => {
    await command("/o");
    await desktop.waitForText("h1", "Overview");
    if (unlockRequired) await unlock("Open Overview");
    await shows(pane, accepted.task.title);
  };
  const output = pane + ' pre[aria-label="Session output"]';
  const status = (value) => eventually(() => desktop.execute(
    "return !!document.querySelector(arguments[0] + ' [data-status=' + arguments[1] + ']');", pane, value,
  ), "The native Overview did not observe " + value + ".", account ? 115_000 : 20_000);
  await openOverview(true);
  if (provider) {
    await status("running");
    await shows(output, marker);
    assert.equal(await desktop.execute("return document.querySelector(arguments[0]).textContent;", output), provider.truncatedOutput);
    await shows(pane, "Earlier output omitted.");
    await desktop.close();
    desktop = undefined;
    await open();
    await openOverview(true);
    await status("running");
    await shows(output, marker);
    provider.finish();
  }
  await status("completed");
  await shows(output, marker);
  const settlement = await eventually(() => store.eventsOfKind("task.delegation_settled")[0], "The native result was not saved.");
  assert.equal(settlement.details.status, "completed");

  const assertDetails = async () => {
    await click(pane + " button[aria-expanded=false]");
    await shows(pane + " .details", "Codex");
    await shows(pane + " .details", assignment.runId);
    await shows(pane + " .details", accepted.session.id);
    const reason = await (await desktop.element(pane + " [data-control-unavailable]")).text();
    assert.ok(reason.trim(), "The currently unavailable Codex controls need an explicit reason.");
    assert.equal(await desktop.execute("return !!document.querySelector(arguments[0] + ' [data-operation]');", pane), false);
    const usage = await eventually(() => store.eventsOfKind("usage.observed")
      .map(({ subject }) => store.getUsage(subject.id)).find((sample) => sample?.sessionId === accepted.session.id),
    "The native session usage was not persisted.");
    assert.equal(usage.metering, "reported");
    const measurement = await desktop.execute(
      "return Object.fromEntries(Array.from(document.querySelectorAll(arguments[0] + ' .details dt')).map(el => [el.textContent, el.nextElementSibling.textContent]));",
      pane,
    );
    assert.equal(Number(measurement["Input tokens"].replaceAll(",", "")), usage.inputTokens);
    assert.equal(Number(measurement["Output tokens"].replaceAll(",", "")), usage.outputTokens);
    if (provider) assert.deepEqual([usage.inputTokens, usage.outputTokens], [scriptedUsage.input, scriptedUsage.output]);
    return usage.id;
  };
  const usageId = await assertDetails();
  t.diagnostic("The single native Codex run completed with its expected output and reported usage.");
  await command("/m");
  if (provider) await unlock("Open Manager");
  await desktop.waitForText("#manager-lock", "Lock manager");
  if (provider) {
    assert.equal((await confirmManager(accepted, replayPrompt, "The original request was replayed.")).id, intent.id);
    assert.equal(store.eventsOfKind("action.requested").filter(({ details }) => details?.action.target.id === accepted.task.id).length, 1);
    provider.assertLaunches(1);
  }
  await openOverview(false);
  await status("completed");
  await shows(output, marker);

  await desktop.close();
  desktop = undefined;
  await open();
  await openOverview(true);
  await status("completed");
  await shows(output, marker);
  assert.equal(await assertDetails(), usageId);
  assert.equal(attempts().length, 1);
  provider?.assertLaunches(1);
  assert.equal(store.eventsOfKind("task.completed").length, 0, "Native exit must not mark an unverified task complete.");

  const review = (operation) => bundledReview(host, environment, operator, operation, intent.id);
  assert.notEqual((await bundledReview(host, environment, mcpToken, "result", intent.id)).code, 0);
  assert.notEqual((await review("review")).code, 0, "The trusted reviewer must integrate the exact retained edit before review.");
  const result = await review("result");
  assert.equal(result.code, 0, "The packaged verifier could not retrieve the settled result.");
  assert.deepEqual(result.value.assignment, assignment);
  assert.equal(result.value.observation.snapshot.status, "completed");
  const worker = result.value.workspace;
  assert.ok(worker && isAbsolute(worker), "The operator needs its retained worker checkout.");
  const integrated = enrolled.authority.root;
  assert.equal(await readFile(join(integrated, target), "utf8"), initial);
  assert.ok(await readFile(join(worker, target), "utf8") === delivered, "The native worker did not write the exact scoped file.");
  assert.equal(git(worker, "status", "--porcelain=v1", "--untracked-files=all"), "M " + target);
  await copyFile(join(worker, target), join(integrated, target));
  const protectedCheck = await readFile(join(integrated, guard), "utf8");
  await writeFile(join(integrated, guard), "process.exitCode = 0;\n");
  assert.notEqual((await review("review")).code, 0, "The packaged reviewer must reject a rewritten protected check.");
  await writeFile(join(integrated, guard), protectedCheck);
  const approved = await review("review");
  assert.equal(approved.code, 0, "The exact integrated source and native receipt could not be reviewed.");
  const { source, receiptDigest } = approved.value;
  const complete = () => bundledReview(host, environment, operator, "complete", intent.id, source.digest, receiptDigest);
  const verification = await complete();
  assert.equal(verification.code, 0, "The packaged trusted verification did not pass.");
  assert.equal(verification.value.verification.conforms, true);
  assert.ok(verification.value.verification.checks.some(({ outcome }) => outcome.status === "passed"));
  assert.equal(store.eventsOfKind("task.completed").length, 1);

  t.diagnostic(JSON.stringify({ os: "Linux x64", codex: release, model: configuration.profile.model,
    webkit: desktop.capabilities.browserVersion, provider: account ? "authorized account" : "scripted loopback",
    nativeLaunches: attempts().length, nativeStatus: "completed", usage: "reported", guardedCompletion: "passed" }));
});
