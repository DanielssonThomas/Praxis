import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, readlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { startDesktop } from "./desktop-fixture.mjs";
import { startHermesFixture, until } from "./hermes-fixture.mjs";

const launchStatus = "praxis-host-launch [role=status]";
const retryButton = "praxis-host-launch button";
const readyMessage = "Local Praxis host ready.";

function execute(command, args) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 10_000 }).trim();
}

async function pidFor(executable) {
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const actual = await readlink(`/proc/${name}/exe`).catch(() => undefined);
    if (actual === executable) return Number(name);
  }
}

async function verifyLoopbackHost(executable) {
  const pid = await until(() => pidFor(executable), "The packaged Node sidecar did not start.");
  const listening = execute("ss", ["-H", "-ltnp"]).split("\n").filter((row) => row.includes(`pid=${pid},`));
  assert.equal(listening.length, 1, "the sidecar should have exactly one listener");
  const address = listening[0].trim().split(/\s+/)[3];
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const response = await fetch(`http://${address}/api/settings`, { signal: AbortSignal.timeout(4_000) });
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).manager.profile, "string");
  return pid;
}

async function closeWindow(binary, sidecar) {
  const pid = await until(() => pidFor(binary), "The packaged desktop process did not start.");
  const window = execute("xdotool", ["search", "--onlyvisible", "--pid", String(pid), "--name", "^Praxis$"]);
  assert.match(window, /^\d+$/, "the desktop should have exactly one visible Praxis window");
  execute("xdotool", ["windowactivate", "--sync", window, "key", "alt+F4"]);
  await until(async () => (await pidFor(binary)) === undefined, "The desktop stayed running after closing its window.");
  await until(async () => (await pidFor(sidecar)) === undefined, "The desktop-owned host survived its owner.");
}

test("packaged Linux desktop recovers the local host and leaves independent Hermes work running", {
  timeout: 120_000,
}, async (t) => {
  const packagePath = process.env.PRAXIS_DESKTOP_DEB;
  assert.ok(packagePath && isAbsolute(packagePath), "Set PRAXIS_DESKTOP_DEB to the absolute development package path.");
  assert.equal(execute("dpkg-deb", ["--field", packagePath, "Architecture"]), "amd64");
  const directory = await mkdtemp(join(tmpdir(), "praxis-desktop-launch-"));
  let desktop;
  t.after(async () => {
    try {
      await desktop?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const installed = join(directory, "installed");
  execute("dpkg-deb", ["--extract", packagePath, installed]);
  const binary = join(installed, "usr/bin/praxis-desktop");
  const sidecar = join(installed, "usr/lib/Praxis/host/bin/node");
  const withheld = join(directory, "withheld-node");
  const launcher = await readFile(join(installed, "usr/share/applications/Praxis.desktop"), "utf8");
  assert.match(launcher, /^Terminal=false$/m);
  assert.equal(execute(sidecar, ["--version"]), process.version);

  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  const { runtime } = await startHermesFixture(t, async () => {
    requests += 1;
    await hold;
    return { message: { role: "assistant", content: "The independent Hermes work completed." } };
  });
  try {
    const run = await runtime.createAssignment({
      schemaVersion: 1, id: "session_desktop_lifecycle", taskId: "task_desktop_lifecycle",
    }, "Wait for the Praxis desktop lifecycle fixture.");
    await until(() => requests === 1, "The independent Hermes work did not begin.");
    const environment = Object.fromEntries(Object.keys(process.env)
      .filter((name) => name.startsWith("PRAXIS_"))
      .map((name) => [name, undefined]));
    environment.PRAXIS_CONFIG_FILE = join(directory, "settings.json");
    environment.XDG_DATA_HOME = join(directory, "data");
    environment.XDG_CONFIG_HOME = join(directory, "config");
    environment.XDG_CACHE_HOME = join(directory, "cache");
    const evidence = process.env.PRAXIS_DESKTOP_EVIDENCE_DIR;
    if (evidence) await mkdir(evidence, { recursive: true });

    await rename(sidecar, withheld);
    desktop = await startDesktop(binary, { environment });
    const wryVersion = desktop.capabilities.browserVersion;
    const webkitVersion = execute("pkg-config", ["--modversion", "webkit2gtk-4.1"]);
    assert.equal((await desktop.handles()).length, 1);
    assert.deepEqual(await desktop.execute("return [location.protocol, location.host]"), ["tauri:", "localhost"]);
    await desktop.waitForText("h1", "Manager");
    await desktop.waitForText(launchStatus, "The local Praxis host resources are missing.");
    if (evidence) await desktop.screenshot(join(evidence, "desktop-host-missing.png"));

    await rename(withheld, sidecar);
    await (await desktop.element(retryButton)).click();
    await desktop.waitForText(launchStatus, readyMessage);
    const hostPid = await verifyLoopbackHost(sidecar);
    if (evidence) await desktop.screenshot(join(evidence, "desktop-host-ready.png"));

    process.kill(hostPid, "SIGKILL");
    await desktop.waitForText(launchStatus, "The local Praxis host stopped.");
    await (await desktop.element(retryButton)).click();
    await desktop.waitForText(launchStatus, readyMessage);
    assert.notEqual(await verifyLoopbackHost(sidecar), hostPid);
    await closeWindow(binary, sidecar);
    await desktop.close();
    desktop = undefined;
    assert.equal((await runtime.inspectAssignment(run)).status, "running");

    desktop = await startDesktop(binary, { environment });
    await desktop.waitForText(launchStatus, readyMessage);
    assert.equal((await desktop.handles()).length, 1);
    await verifyLoopbackHost(sidecar);
    assert.equal((await runtime.inspectAssignment(run)).status, "running");
    assert.equal(requests, 1);
    await closeWindow(binary, sidecar);
    await desktop.close();
    desktop = undefined;
    t.diagnostic(`One Linux window (WebKitGTK ${webkitVersion}, Wry ${wryVersion}), redacted failure, retry, loopback binding, host cleanup, reopen and continuing Hermes work passed.`);
  } finally {
    release();
  }
});
