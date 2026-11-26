import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const crate = fileURLToPath(new URL("../src-tauri", import.meta.url));
const source = join(crate, "src");
const paths = [join(crate, "build.rs")];
for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".rs")) paths.push(join(entry.parentPath, entry.name));
}

const infrastructure = /\bstd\s*::\s*(?:fs|io|net|process|thread)\b/;
for (const path of paths) {
  const name = relative(crate, path).replaceAll("\\", "/");
  const code = await readFile(path, "utf8");
  assert.ok(code.trimEnd().split(/\r?\n/).length <= 500, `${name} exceeds 500 handwritten lines`);
  if (name === "src/main.rs" || name === "src/lib.rs" || name.startsWith("src/commands/")) {
    assert.doesNotMatch(code, infrastructure, `${name} must delegate infrastructure to a service`);
  }
  if (name.startsWith("src/services/") || name.startsWith("src/state/")) {
    assert.doesNotMatch(code, /\btauri\s*::/, `${name} must not depend on Tauri`);
  }
}
console.log(`Rust module boundaries and file sizes passed for ${paths.length} files.`);
