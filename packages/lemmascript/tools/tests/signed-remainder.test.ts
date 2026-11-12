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
  const source = project.createSourceFile("remainder.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "remainder.ts", resolveOptions({ "dafny-library": "local" }, "test"));
}

function body(output: string, name: string): string {
  const start = output.indexOf(`function ${name}(`);
  return output.slice(start, output.indexOf("}", start));
}

test("a remainder of a negative natural-operand result keeps JavaScript's sign", () => {
  // JavaScript truncates: each of these is -1, where Dafny's Euclidean `%` gives 1.
  assert.deepEqual([(1 - 4) % 2, (1 + -4) % 2, (1 * -3) % 2, (-3) % 2], [-1, -1, -1, -1]);
  const output = emit(`
export function difference(): number { return (1 - 4) % 2 }
export function sum(): number { return (1 + -4) % 2 }
export function product(): number { return (1 * -3) % 2 }
export function negation(): number { return (-3) % 2 }
export function natural(): number { return (1 + 6) % 2 }
`);
  for (const name of ["difference", "sum", "product", "negation"])
    assert.match(body(output, name), /JSRem\(/, name);
  // Natural operands stay natural: no negative dividend, so no JSRem.
  assert.doesNotMatch(body(output, "natural"), /JSRem/);
  assert.match(body(output, "natural"), /\(\(1 \+ 6\) % 2\)/);
});

test("a length minus a constant is signed before its remainder", () => {
  assert.equal((["a"].length - 4) % 2, -1);
  const output = emit(`export function lengthRem(xs: number[]): number { return (xs.length - 4) % 2 }`);
  assert.match(body(output, "lengthRem"), /JSRem\(\(\|xs\| - 4\), 2\)/);
});
