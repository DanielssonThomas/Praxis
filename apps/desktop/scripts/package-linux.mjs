import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const desktop = join(repository, "apps", "desktop");
const nodeVersion = (await readFile(join(repository, ".node-version"), "utf8")).trim();
if (process.platform !== "linux" || process.arch !== "x64" || process.version !== `v${nodeVersion}`) {
  throw new Error(`Package Praxis on Linux x64 with the pinned Node.js ${nodeVersion} distribution.`);
}

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });
const workspace = await mkdtemp(join(tmpdir(), "praxis-linux-package-"));
try {
  run("npm", ["run", "build"], repository);
  await cp(join(repository, "package.json"), join(workspace, "package.json"));
  await cp(join(repository, "package-lock.json"), join(workspace, "package-lock.json"));
  for (const group of ["apps", "packages"]) {
    for (const entry of await readdir(join(repository, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = join(repository, group, entry.name);
      const target = join(workspace, group, entry.name);
      await mkdir(target, { recursive: true });
      await cp(join(source, "package.json"), join(target, "package.json"));
    }
  }
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--workspace", "@praxis/shell"], workspace);

  for (const name of await readdir(join(workspace, "node_modules", "@praxis"))) {
    const source = join(repository, "packages", name);
    const target = join(workspace, "packages", name);
    await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
    if ((await readdir(source)).includes("web")) {
      await cp(join(source, "web"), join(target, "web"), { recursive: true });
    }
  }

  const host = join(workspace, "host");
  await mkdir(join(host, "bin"), { recursive: true });
  await cp(process.execPath, join(host, "bin", "node"));
  await cp(join(dirname(process.execPath), "..", "LICENSE"), join(host, "bin", "LICENSE"));
  await cp(join(workspace, "packages", "shell"), join(host, "app"), { recursive: true });
  await cp(join(workspace, "node_modules"), join(host, "node_modules"), {
    recursive: true,
    dereference: true,
    filter: (source) => source !== join(workspace, "node_modules", ".bin"),
  });

  const bundle = JSON.stringify({ bundle: { resources: { [host]: "host" } } });
  run("tauri", ["build", "--debug", "--bundles", "deb", "--ci", "--config", bundle, "--", "--locked"], desktop);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
