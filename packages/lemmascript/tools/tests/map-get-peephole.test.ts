import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { peepholeModule } from "../src/peephole.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";

// The same pipeline lsc.ts runs for the Dafny backend, peephole included.
function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("get.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  const types = typesFile ? peepholeModule(typesFile, "dafny") : undefined;
  const def = peepholeModule(defFile, "dafny");
  return emitDafnyFile({ ...def, decls: [...(types?.decls ?? []), ...def.decls] });
}

test("a Map.get binding an arm still reads keeps its declaration", () => {
  const output = emit(`export function f(m: Map<string, number>, k: string): number | undefined {
  let force = 0;
  const x = m.get(k);
  if (x !== undefined) return x; else return x;
}`);
  assert.match(output, /return x;/, output);
  assert.match(output, /var x(: [^:]+)? := /, output);
});

test("a Map.get binding only the match reads still collapses to a presence check", () => {
  const output = emit(`export function f(m: Map<string, number>, k: string): number {
  let force = 0;
  const x = m.get(k);
  if (x !== undefined) return x; else return 0;
}`);
  assert.match(output, /if \(?k in m\)?/, output);
  assert.doesNotMatch(output, /var x(: [^:]+)? := /, output);
});
