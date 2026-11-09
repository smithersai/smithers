import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, ScriptTarget } from "ts-morph";
import { moved, above } from "../fixtures/real-field.ts";
import { between } from "../fixtures/real-field-wrong.ts";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";

function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("spot.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "spot.ts", resolveOptions({ "dafny-library": "local" }, "test"));
}

test("the fixtures hold fractional field values at run time", () => {
  assert.deepEqual(moved({ intent: 1, y: 0 }, 2.5), { intent: 2, y: 2.5 });
  assert.equal(above({ intent: 0, y: 1.5 }, 1.25), true);
  assert.equal(between({ y: 0.5 }), true);
});

test("a real field is a Dafny real; number fields stay integers", () => {
  const output = emit("type real = number\nexport interface Spot { readonly intent: number; readonly y: real; readonly z?: real }\n"
    + "export function f(s: Spot): Spot { return s; }");
  assert.match(output, /datatype Spot = Spot\(intent: int, y: real, z: Option<real>\)/);
});
