import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.js";
import { resolveModule } from "../src/resolve.js";
import { narrowModule } from "../src/narrow.js";
import { transformModuleDafny } from "../src/transform.js";
import { emitDafnyFile } from "../src/dafny-emit.js";
import { counted, keyNeedsOp } from "../fixtures/narrowed-presence.ts";

function emitted(): string {
  const project = new Project({ compilerOptions: {
    strict: true, target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true,
  } });
  const source = project.addSourceFileAtPath(fileURLToPath(new URL("../fixtures/narrowed-presence.ts", import.meta.url)));
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "the regression must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] });
}

test("the fixture's functions agree with source execution", () => {
  assert.deepEqual([keyNeedsOp("a", undefined), keyNeedsOp(undefined, "k"), keyNeedsOp(undefined, undefined), keyNeedsOp("ab", "k"), keyNeedsOp("a", "k")], [true, false, false, true, false]);
  assert.deepEqual([counted(undefined), counted(""), counted("abc")], [0, 0, 3]);
});

test("a presence check on a value its arm already bound is a constant, never a binder compared with None", () => {
  const output = emitted();
  assert.doesNotMatch(output, /i_op_val (!=|==) None/, output);
  // op is bound, key is absent: the terminating branch's `op !== undefined` is true.
  assert.match(output, /\(\|i_op_val\| > \|i_key_val\|\)\s+case None =>\s+true\s/, output);
});

test("a loop's decreases clause reads the bound value", () => {
  const output = emitted();
  assert.doesNotMatch(output, /\|text\|/, output);
  assert.match(output, /decreases \(\|i_text_val\| - i\)/, output);
});
