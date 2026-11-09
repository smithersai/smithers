import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Project, ScriptTarget } from "ts-morph";
import { includesAt, startsAt, endsAt, positionedPredicates,
  clampedPredicates, emptyNeedlePastEnd } from "../fixtures/string-search-positions.ts";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny, transformModuleLean } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { emitLeanFile, resetLeanModule } from "../src/lean-emit.ts";
import { resolveOptions } from "../src/config.ts";

function sourceModule(text?: string) {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = text === undefined
    ? project.addSourceFileAtPath(fileURLToPath(new URL("../fixtures/string-search-positions.ts", import.meta.url)))
    : project.createSourceFile("search.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  return narrowModule(resolveModule(extractModule(source)));
}

test("source search predicates distinguish positions and clamp integer bounds", () => {
  assert.equal(positionedPredicates(), true);
  assert.equal(clampedPredicates(), true);
  assert.equal(emptyNeedlePastEnd(), 3);
  for (const text of ["", "abc", "aba"]) {
    for (const needle of ["", "a", "b", "abc", "abcd"]) {
      for (const position of [-10, -1, 0, 1, 2, 3, 10]) {
        assert.equal(includesAt(text, needle, position), text.indexOf(needle, position) >= 0);
        const bound = Math.max(0, Math.min(position, text.length));
        assert.equal(startsAt(text, needle, position), text.slice(bound).startsWith(needle));
        assert.equal(endsAt(text, needle, position), text.slice(0, bound).endsWith(needle));
      }
    }
  }
});

for (const profile of ["legacy-scalar", "javascript-utf16"] as const) {
  test(`Dafny preserves each string search position in ${profile} mode`, () => {
    const { typesFile, defFile } = transformModuleDafny(sourceModule());
    const output = emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
      "search.ts", resolveOptions({ "string-semantics": profile, "dafny-library": "local" }, "test"));
    assert.match(output, /StringIndexOfFrom\(text, needle, StringSearchPosition\(text, position\)\)/);
    assert.match(output, /StringStartsWithAt\(text, needle, position\)/);
    assert.match(output, /StringEndsWithAt\(text, needle, position\)/);
    assert.match(output, /StringIndexOfFrom\("abc", "", StringSearchPosition\("abc", 10\)\)/);
  });
}

test("Lean refuses the unsupported indexOf position instead of discarding it", () => {
  const { typesFile, defFile } = transformModuleLean(sourceModule(
    'export function search(s: string, p: number): number { return s.indexOf("a", p); }'));
  resetLeanModule();
  assert.throws(() => emitLeanFile({ ...defFile,
    decls: [...(typesFile?.decls ?? []), ...defFile.decls] }), /indexOf.*position|indexOf.*argument/i);
});

test("default-position searches do not add positional helpers", () => {
  const { typesFile, defFile } = transformModuleDafny(sourceModule(`
    export function ordinary(s: string): boolean {
      return s.startsWith("a") && s.endsWith("b") && s.includes("a");
    }`));
  const output = emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] });
  assert.doesNotMatch(output, /StringSearchPosition|StringStartsWithAt|StringEndsWithAt/);
});
