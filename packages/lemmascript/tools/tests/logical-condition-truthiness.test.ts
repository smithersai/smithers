import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";

function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("guard.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "guard.ts", resolveOptions({ "dafny-library": "local" }, "test"));
}

test("a boolean-typed conjunction converts its numeric left operand", () => {
  const output = emit("export function f(n: number): number { if (n && true) return 1; return 0; }");
  assert.match(output, /if \(\(n != 0\) && true\) then\s+1\s+else\s+0/);
});

test("a boolean-typed disjunction converts its string left operand", () => {
  const output = emit("export function f(s: string, b: boolean): number { return s || b ? 1 : 0; }");
  assert.match(output, /if \(\(\|s\| > 0\) \|\| b\) then\s+1\s+else\s+0/);
});

test("a boolean-typed loop guard converts its numeric operand", () => {
  const output = emit("export function f(n: number): number {\n  let i = n;\n  while (i && i > 1) {\n    //@ decreases i\n    i = i - 1;\n  }\n  return i;\n}");
  assert.match(output, /while \(\(i != 0\) && \(i > 1\)\)/);
});
