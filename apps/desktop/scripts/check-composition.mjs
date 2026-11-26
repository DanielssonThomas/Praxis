import { readdirSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const app = fileURLToPath(new URL("../src/app/", import.meta.url));
const levels = ["atom", "molecule", "organism", "template"];
const components = new Map();
const modules = new Map();
const errors = [];
let edges = 0;

function localPath(file) {
  return relative(app, file).split(sep).join("/");
}

function owner(file) {
  const [area, feature] = localPath(file).split("/");
  return area === "features" ? `features/${feature}` : area;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return extname(file) === ".ts" ? [file] : [];
  });
}

function report(file, message) {
  errors.push(`${localPath(file)}: ${message}`);
}

function dependencies(source) {
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      imports.push(node.moduleSpecifier);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      imports.push(node.arguments[0]);
    }
    node.forEachChild(visit);
  }
  visit(source);
  return imports.filter((node) => node && ts.isStringLiteralLike(node) && node.text.startsWith("."))
    .map((node) => node.text);
}

function inspect(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  modules.set(file, dependencies(source));
  for (const statement of source.statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && !file.endsWith(".model.ts")) {
      report(file, `${statement.name.text} must be declared in a .model.ts file`);
    }
    if (!ts.isClassDeclaration(statement)) continue;
    for (const decorator of ts.getDecorators(statement) ?? []) {
      const call = decorator.expression;
      if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "Component") continue;
      const layer = /-(atom|molecule|organism|template)\.component\.ts$/.exec(file)?.[1];
      if (!layer) {
        report(file, "component name must carry its atomic layer");
        continue;
      }
      components.set(file, levels.indexOf(layer));
      const options = call.arguments[0];
      if (!options || !ts.isObjectLiteralExpression(options)) {
        report(file, "component must declare colocated external resources");
        continue;
      }
      for (const [name, suffix] of [["templateUrl", ".html"], ["styleUrl", ".css"]]) {
        const resource = `./${basename(file, ".ts")}${suffix}`;
        const property = options.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(source) === name);
        if (!property || !ts.isStringLiteralLike(property.initializer) || property.initializer.text !== resource
            || !existsSync(resolve(dirname(file), resource))) {
          report(file, `${name} must point to the colocated ${resource}`);
        }
      }
    }
  }
}

function targetOf(file, specifier) {
  const path = resolve(dirname(file), specifier);
  return [path, `${path}.ts`, join(path, "index.ts")].find((candidate) => modules.has(candidate));
}

function checkComposition(file, source, visited) {
  for (const specifier of modules.get(source)) {
    const target = targetOf(source, specifier);
    if (!target || visited.has(target)) continue;
    visited.add(target);
    if (components.has(target)) {
      edges++;
      if (components.get(file) <= components.get(target)) {
        report(file, `composition must point to a lower layer: ${localPath(target)}`);
      }
      continue;
    }
    checkComposition(file, target, visited);
  }
}

for (const file of sourceFiles(app)) inspect(file);
for (const [file, imports] of modules) {
  for (const specifier of imports) {
    const target = targetOf(file, specifier);
    if (!target) continue;
    const targetOwner = owner(target);
    if (targetOwner.startsWith("features/") && targetOwner !== owner(file)
        && localPath(target) !== `${targetOwner}/index.ts`) {
      report(file, `use the public entry point for ${targetOwner}: ${localPath(target)}`);
    }
  }
  if (components.has(file)) checkComposition(file, file, new Set());
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Atomic composition passed for ${components.size} components and ${edges} dependencies.`);
}
