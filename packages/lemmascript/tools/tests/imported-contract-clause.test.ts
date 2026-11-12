import assert from "node:assert/strict";
import test from "node:test";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.js";
import { resolveModule } from "../src/resolve.js";

// A copied contract either keeps every clause or fails: dropping a precondition that does not parse would turn the
// imported function's postcondition into an axiom for every input.
function resolveImporter(libraryContract: string[]) {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true, target: ScriptTarget.ESNext } });
  project.createSourceFile("/lib.ts", [
    ...libraryContract,
    "export function f(n: number): number { return n > 0 ? 42 : 0 }",
  ].join("\n"));
  const importer = project.createSourceFile("/use.ts", [
    "import { f } from \"./lib\"",
    "//@ verify",
    "//@ ensures \\result === 42",
    "export function g(): number { return f(0) }",
  ].join("\n"));
  return resolveModule(extractModule(importer));
}

test("an imported precondition that does not parse fails compilation, naming the function and the clause", () => {
  assert.throws(() => resolveImporter(["//@ requires n >", "//@ ensures \\result === 42"]),
    /extern f: \/\/@ requires n >: /);
});

test("an imported postcondition that does not parse fails compilation", () => {
  assert.throws(() => resolveImporter(["//@ requires n > 0", "//@ ensures \\result ==="]),
    /extern f: \/\/@ ensures \\result ===: /);
});

test("a well-formed imported contract keeps its precondition", () => {
  const module = resolveImporter(["//@ requires n > 0", "//@ ensures \\result === 42"]);
  const f = module.externs.find(e => e.qualified === "f");
  assert.equal(f?.requires.length, 1);
  assert.equal(f?.ensures.length, 1);
});
