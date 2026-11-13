import assert from "node:assert/strict";
import test from "node:test";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.js";
import { resolveModule } from "../src/resolve.js";
import { narrowModule } from "../src/narrow.js";
import { transformModuleLean } from "../src/transform.js";
import { emitLeanFile, resetLeanModule } from "../src/lean-emit.js";

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


for (const contract of [[], ["//@ requires n > 0"], ["//@ requires n > 0", "//@ requires n < 10"]]) {
  test("Lean omits a characterizing axiom without postconditions (" + contract.length + " preconditions)", () => {
    const { typesFile } = transformModuleLean(narrowModule(resolveImporter(contract)));
    assert.ok(typesFile);
    const external = typesFile.decls.find(d => d.kind === "extern" && d.name === "f");
    assert.ok(external?.kind === "extern");
    assert.equal(external.requires.length, contract.length, "preconditions remain in the IR");
    resetLeanModule();
    const output = emitLeanFile(typesFile);
    assert.match(output, /^opaque f \(n : Int\) : Int$/m);
    assert.doesNotMatch(output, /axiom f_spec/);
  });
}

for (const contract of [
  ["//@ ensures \\result === 42"],
  ["//@ requires n > 0", "//@ ensures \\result === 42"],
  ["//@ requires n > 0", "//@ requires n < 10", "//@ ensures \\result === 42", "//@ ensures \\result > n"],
]) {
  test("Lean retains every precondition and postcondition in an extern spec (" + contract.length + " clauses)", () => {
    const { typesFile } = transformModuleLean(narrowModule(resolveImporter(contract)));
    assert.ok(typesFile);
    resetLeanModule();
    const output = emitLeanFile(typesFile);
    const axiom = output.split("\n").find(line => line.startsWith("@[grind] axiom f_spec"));
    assert.ok(axiom);
    assert.match(axiom, /\(f n = 42\)/);
    if (contract.some(c => c.includes("requires n > 0"))) assert.match(axiom, /\(n > 0\) →/);
    if (contract.some(c => c.includes("requires n < 10"))) assert.match(axiom, /\(n < 10\) →/);
    if (contract.some(c => c.includes("result > n"))) assert.match(axiom, /∧ \(f n > n\)/);
    assert.doesNotMatch(axiom, /→\s*$/);
  });
}
