import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test("the desktop-owned host closes when its private launch pipe ends", { timeout: 10_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "praxis-desktop-host-"));
  const abort = new AbortController();
  const host = spawn(process.execPath, ["packages/shell/dist/cli.js"], {
    env: { HOME: home, PRAXIS_CONFIG_FILE: join(home, "settings.json"), PRAXIS_DESKTOP_HOST: "1", PRAXIS_PORT: "0" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exit = once(host, "exit");
  t.after(async () => {
    abort.abort();
    host.kill();
    await exit;
    await rm(home, { recursive: true, force: true });
  });

  const ready = await Promise.race([
    once(host.stdout, "data").then(([chunk]) => chunk.toString()),
    exit.then(() => ""),
  ]);
  assert.match(ready, /^Praxis at http:\/\/127\.0\.0\.1:\d+\//);
  host.stdin.end();
  const result = await Promise.race([exit, delay(2_000, null, { signal: abort.signal })]);
  assert.deepEqual(result, [0, null], "the desktop-owned host must exit normally after its owner disconnects");
});
