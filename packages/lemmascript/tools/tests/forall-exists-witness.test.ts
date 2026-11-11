import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Project, ScriptTarget } from "ts-morph";
import { pieces, copy, copyOne } from "../fixtures/forall-exists-witness.ts";
import { extractModule, rawAssert } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny, transformModule } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";
import { emitLeanFile, resetLeanModule } from "../src/lean-emit.ts";

function front(text: string) {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("witness.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  return narrowModule(resolveModule(extractModule(source)));
}

function emit(text: string): string {
  const { typesFile, defFile } = transformModuleDafny(front(text));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "witness.ts", resolveOptions({}, "test"));
}

const FIXTURE = readFileSync(new URL("../fixtures/forall-exists-witness.ts", import.meta.url), "utf8");

const GOAL = "forall(i, 0 <= i && i < out.length ==> exists(k, 0 <= k && k < parts.length && out[i] == parts[k]))";
const COPY = (assertion: string) => [
  "//@ verify",
  "//@ requires forall(i, 0 <= i && i < a.length ==> exists(k, 0 <= k && k < parts.length && a[i] == parts[k]))",
  "//@ ensures forall(i, 0 <= i && i < \\result.length ==> exists(k, 0 <= k && k < parts.length && \\result[i] == parts[k]))",
  "export function copy(parts: ReadonlyArray<number>, a: ReadonlyArray<number>): ReadonlyArray<number> {",
  "  const out = a",
  `  //@ assert ${assertion}`,
  "  return out",
  "}",
].join("\n");

test("the fixture's functions keep each piece's part and parity", () => {
  assert.deepEqual(pieces(["a", "b", "", "c"]), [
    { code: false, text: "a" }, { code: true, text: "b" }, { code: true, text: "c" }]);
  assert.deepEqual(pieces(["", "x", ""]), [{ code: true, text: "x" }]);
  assert.deepEqual(pieces([]), []);
  assert.deepEqual(copy([1, 2], [2, 2, 1]), [2, 2, 1]);
  assert.deepEqual(copyOne([4], [4]), [4]);
});

test("an assertion splits at the first top-level `by exists(`", () => {
  assert.deepEqual(rawAssert(" x > 0 ", 3), { kind: "assert", expr: "x > 0", line: 3 });
  assert.deepEqual(rawAssert(`${GOAL} by exists(k, k == 0)`, 4),
    { kind: "assert", expr: GOAL, line: 4, witness: "exists(k, k == 0)" });
  assert.deepEqual(rawAssert('s == "go by car"', 5), { kind: "assert", expr: 's == "go by car"', line: 5 });
  assert.deepEqual(rawAssert("f(a by b)", 6), { kind: "assert", expr: "f(a by b)", line: 6 });
  assert.deepEqual(rawAssert("bypass == byte", 7), { kind: "assert", expr: "bypass == byte", line: 7 });
  assert.deepEqual(rawAssert("x == by + 1", 8), { kind: "assert", expr: "x == by + 1", line: 8 });
});

test("a witness assertion emits a forall statement that picks k, over a named body", () => {
  const out = emit(COPY(`${GOAL} by exists(k, 0 <= k && k < parts.length && a[i] == parts[k])`));
  const name = /predicate (LscExists_copy_\d+)\(/.exec(out)?.[1];
  assert.ok(name, out);
  assert.equal(out.match(/^predicate /gm)?.length, 1, "goal, precondition and postcondition share one body");
  assert.match(out, new RegExp(`requires forall i: int \\{:trigger ${name}\\(i, a, parts\\)\\} \\{:trigger a\\[i\\]\\} :: ${name}\\(i, a, parts\\)`));
  assert.match(out, new RegExp(`ensures forall i: int \\{:trigger ${name}\\(i, res, parts\\)\\} \\{:trigger res\\[i\\]\\} :: ${name}\\(i, res, parts\\)`));
  assert.match(out, new RegExp(`forall i: int\\n\\s+ensures ${name}\\(i, out, parts\\)`));
  assert.match(out, new RegExp(`assert ${name}\\(i, a, parts\\);\\n\\s+var k: int :\\| .*a\\[i\\] == parts\\[k\\]`));
  assert.match(out, new RegExp(`assert forall i: int \\{:trigger ${name}\\(i, out, parts\\)\\}`));
});

test("a method without a witness assertion keeps its contract as written", () => {
  const out = emit(COPY(GOAL));
  assert.doesNotMatch(out, /LscExists|:\|/);
  assert.match(out, /ensures forall i: int :: \(\(0 <= i\) ==> \(i < \|res\|\) ==> exists k/);
});

test("the fixture's loop pick asserts nothing it has not proved", () => {
  const out = emit(FIXTURE);
  const body = out.slice(out.indexOf("method pieces"), out.indexOf("method copy("));
  assert.doesNotMatch(body, /assert LscExists/, "the loop's pick is its invariant, not a precondition");
  assert.match(body, /var k: int :\| /);
});

test("a witness needs forall(i, A ==> exists(k, B)) and the same k", () => {
  assert.throws(() => emit(COPY("out.length >= 0 by exists(k, k == 0)")), /expected forall\(i, A ==> exists\(k, B\)\) by exists\(k, C\)/);
  assert.throws(() => emit(COPY(`${GOAL} by out.length >= 0`)), /Unexpected/);
  assert.throws(() => emit(COPY(`${GOAL} by exists(j, j == 0)`)), /the pick binds j, the goal's exists binds k/);
});

test("Lean rejects a witness assertion rather than drop it", () => {
  resetLeanModule();
  const { defFile } = transformModule(front(COPY(`${GOAL} by exists(k, 0 <= k && k < parts.length && a[i] == parts[k])`)));
  assert.throws(() => emitLeanFile(defFile), /not supported in Lean backend/);
});
