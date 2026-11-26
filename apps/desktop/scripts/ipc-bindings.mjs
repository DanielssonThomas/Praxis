import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const crate = fileURLToPath(new URL("../src-tauri/", import.meta.url));
const tracked = fileURLToPath(new URL("../src/generated/desktop-ipc.ts", import.meta.url));
const operation = process.argv[2];
assert.ok(["generate", "check", "test-drift"].includes(operation), "Choose generate, check or test-drift.");

const directory = await mkdtemp(join(tmpdir(), "praxis-ipc-bindings-"));
try {
  const generated = join(directory, "desktop-ipc.ts");
  execFileSync("cargo", ["run", "--quiet", "--locked", "--features", "ipc-export", "--bin", "export-ipc", "--", generated], {
    cwd: crate,
    stdio: "inherit",
  });

  if (operation === "generate") {
    await mkdir(dirname(tracked), { recursive: true });
    await copyFile(generated, tracked);
  } else if (operation === "check") {
    await verify(generated, tracked);
    console.log("Checked-in desktop IPC bindings match Rust.");
  } else {
    const stale = join(directory, "stale.ts");
    await writeFile(stale, (await readFile(generated, "utf8")) + "\n// stale binding fixture\n");
    await assert.rejects(verify(generated, stale), /Desktop IPC bindings drifted/);
    console.log("Desktop IPC drift check rejected the stale fixture.");
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function verify(generated, tracked) {
  const [fresh, checkedIn] = await Promise.all([generated, tracked].map(async (path) =>
    (await readFile(path, "utf8")).replace(/\r\n/g, "\n")
  ));
  assert.equal(fresh === checkedIn, true, "Desktop IPC bindings drifted. Run npm run generate:desktop-ipc.");
}
