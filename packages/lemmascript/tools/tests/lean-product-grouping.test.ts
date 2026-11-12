import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleLean } from "../src/transform.ts";
import { emitLeanFile, resetLeanModule } from "../src/lean-emit.ts";

// Lean's `*`, `/` and `%` share one precedence and associate left, so a product
// whose right factor is a quotient or remainder must keep that factor grouped.
const CASES = [
  { name: "floorScaled", body: "2 * Math.floor(3 / 2)", value: 2 * Math.floor(3 / 2), lean: "2 * (3 / 2)", wrong: "(2 * 3) / 2 = 3" },
  { name: "remScaled", body: "2 * (3 % 2)", value: 2 * (3 % 2), lean: "2 * (3 % 2)", wrong: "(2 * 3) % 2 = 0" },
  { name: "productQuotient", body: "Math.floor(2 * 3 / 2)", value: Math.floor(2 * 3 / 2), lean: "2 * 3 / 2", wrong: "" },
  { name: "productProduct", body: "2 * (3 * 4)", value: 2 * (3 * 4), lean: "2 * 3 * 4", wrong: "" },
] as const;

function emitLean(): string {
  const text = CASES.map(c => `//@ verify\nexport function ${c.name}(): number {\n  return ${c.body}\n}`).join("\n\n");
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("grouping.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "the regression must be valid TypeScript");
  // Pure functions land in the types file as `def`s; the def file only wraps them.
  const { typesFile } = transformModuleLean(narrowModule(resolveModule(extractModule(source))));
  assert.ok(typesFile);
  resetLeanModule();
  return emitLeanFile(typesFile);
}

test("TypeScript values the regression cases as the grouped Lean does", () => {
  assert.deepEqual(CASES.map(c => c.value), [2, 2, 3, 24]);
});

for (const c of CASES) {
  test(`Lean emits \`${c.body}\` as \`${c.lean}\``, () => {
    const lean = emitLean();
    const body = lean.match(new RegExp(`^def ${c.name} .*:=\\n  (.*)$`, "m"))?.[1];
    assert.equal(body, c.lean, c.wrong && `ungrouped, Lean computes ${c.wrong}`);
  });
}
