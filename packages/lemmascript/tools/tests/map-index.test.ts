import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { replaceAt, offsets } from "../fixtures/map-index.ts";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";

function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("map.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "map.ts", resolveOptions({ "dafny-library": "local" }, "test"));
}

test("the fixture's callbacks see each element's index", () => {
  assert.deepEqual(replaceAt(["a", "b", "c"], 1, "z"), ["a", "z", "c"]);
  assert.deepEqual(replaceAt(["a"], 3, "z"), ["a"]);
  assert.deepEqual(offsets([10, 10, 10]), [10, 11, 12]);
});

test("a two-parameter map callback binds the comprehension index", () => {
  const output = emit("export function f(xs: ReadonlyArray<number>): ReadonlyArray<number> { return xs.map((x, i) => x + i); }");
  assert.match(output, /var x := xs\[i_map\]; var i := i_map;/);
  assert.doesNotMatch(output, /Unknown\)/);
});

test("a one-parameter map callback is unchanged", () => {
  const output = emit("export function f(xs: ReadonlyArray<number>): ReadonlyArray<number> { return xs.map((x) => x + 1); }");
  assert.match(output, /var x := xs\[i_map\]; \(x \+ 1\)/);
});
