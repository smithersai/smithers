import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.js";
import { resolveModule } from "../src/resolve.js";
import { narrowModule } from "../src/narrow.js";
import { transformModuleDafny } from "../src/transform.js";
import { guardedValue, presentValue, zeroSafe, falseSafe, emptySafe, indexSafe } from "../fixtures/spec-nullish-narrowed.ts";

test("nullish keeps present falsy values and an out-of-bounds index uses its fallback", () => {
  assert.equal(guardedValue({}), 0);
  for (const value of [-4, 0, 7]) {
    assert.equal(guardedValue({ item: { value } }), value);
    assert.equal(presentValue({ value }), value);
    assert.equal(zeroSafe(value), value);
  }
  assert.equal(falseSafe(false), false);
  assert.equal(emptySafe(""), "");
  for (const index of [-1, 0, 1, 2]) assert.equal(indexSafe([0, 9], index), index < 0 || index > 1 ? 123 : [0, 9][index]);
});

test("contracts coalescing a guarded optional or a known-present value reach Dafny", () => {
  const project = new Project({ compilerOptions: {
    strict: true, target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true,
  } });
  const source = project.addSourceFileAtPath(fileURLToPath(new URL("../fixtures/spec-nullish-narrowed.ts", import.meta.url)));
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "the regression must be valid TypeScript");
  assert.doesNotThrow(() => transformModuleDafny(narrowModule(resolveModule(extractModule(source)))));
});
