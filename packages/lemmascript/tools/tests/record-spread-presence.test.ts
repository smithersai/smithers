import assert from "node:assert/strict";
import test from "node:test";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.js";
import { resolveModule } from "../src/resolve.js";
import { narrowModule } from "../src/narrow.js";
import { transformModuleDafny } from "../src/transform.js";
import { emitDafnyFile } from "../src/dafny-emit.js";

// `{ ...base, ...override }` copies every own property of `override`, even one whose value is `undefined` or `null`.
// The proof model reads both as an Option None, so None may decide presence only when the key cannot hold either.
function emitted(source: string, exactOptionalPropertyTypes: boolean): string {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: {
    strict: true, exactOptionalPropertyTypes, target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true,
  } });
  const file = project.createSourceFile("/spread.ts", source);
  const errors = file.getPreEmitDiagnostics().filter(d => d.getCode() !== 2318 && d.getCode() !== 6053);
  assert.deepEqual(errors.map(d => d.getMessageText()), [], "the regression must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(file))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] });
}

const merge = (decl: string) => `${decl}
//@ verify
export function merge(base: R, over: R): R { return { ...base, ...over } }
`;

test("JavaScript spreads an own property holding undefined or null over the base's value", () => {
  const optional: { v?: number | undefined } = { v: undefined };
  const nullable: { v: number | null } = { v: null };
  assert.deepEqual({ ...{ v: 1 }, ...optional }, { v: undefined });
  assert.deepEqual({ ...{ v: 1 }, ...nullable }, { v: null });
});

test("an optional key that may hold undefined refuses the merge instead of keeping the base's value", () => {
  assert.throws(() => emitted(merge("interface R { readonly v?: number }"), false), /optional field 'v' of R may be present/);
  assert.throws(() => emitted(merge("interface R { readonly v?: number | undefined }"), true), /optional field 'v'/);
  assert.throws(() => emitted(merge("interface R { readonly v?: number | null }"), true), /optional field 'v'/);
});

test("a required nullable key always overrides, null included", () => {
  const output = emitted(merge("interface R { readonly v: number | null }"), false);
  assert.match(output, /R\(over\.v\)/, output);
  assert.doesNotMatch(output, /match over\.v/, output);
});

test("an exact optional key overrides iff present", () => {
  const output = emitted(merge("interface R { readonly v?: number }"), true);
  assert.match(output, /match over\.v \{ case Some\(\w+\) => Option\.Some\(\w+\) case None => base\.v \}/, output);
});
