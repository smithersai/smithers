import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Project, ScriptTarget } from "ts-morph";
import { moved, above, chooseIf, chooseTernary, negateReal, chooseNegatedIf, chooseNegatedTernary, chooseNegatedOr, defaultReal } from "../fixtures/real-field.ts";
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


const truthinessCases = [
  [undefined, 2, true, 0.5],
  [0, 2, true, 0.5],
  [-0, 2, true, 0.5],
  [0.25, 1, false, 0.25],
  [-0.25, 1, false, -0.25],
] as const;

for (const [value, branch, negated, fallback] of truthinessCases) {
  test("optional real truthiness agrees with JavaScript for " + (Object.is(value, -0) ? "-0" : value), () => {
    for (const choose of [chooseIf, chooseTernary, chooseNegatedIf, chooseNegatedTernary]) {
      assert.equal(choose(value), branch);
    }
    assert.equal(chooseNegatedOr(value), value !== undefined && value > 0 ? 1 : 2);
    assert.equal(negateReal(value), negated);
    assert.equal(defaultReal(value), fallback);
  });
}

test("optional real branches, negation and defaulting test the present payload against zero", () => {
  const output = emit(readFileSync(new URL("../fixtures/real-field.ts", import.meta.url), "utf8"));
  for (const name of ["chooseIf", "chooseTernary", "chooseNegatedIf", "chooseNegatedTernary", "negateReal", "defaultReal"]) {
    const body = output.match(new RegExp("function " + name + "\\([^]*?\\n\\{([^]*?)\\n\\}"))?.[1];
    assert.ok(body, "missing emitted body for " + name);
    assert.match(body, /case Some\((\w+)\) =>[^]*?\1 != \(0 as real\)/,
      name + " must distinguish Some(0) from a nonzero real using real zero");
  }
});


test("an early-return disjunction tests a narrowed real for zero instead of boolean-negating it", () => {
  const output = emit("type real = number\nexport function positive(x: real | undefined): number {\n"
    + "  if (!x || x < 0) return 2;\n  return 1;\n}\n");
  assert.match(output, /case Some\((\w+)\) =>[^]*?\1 == \(0 as real\)/);
  assert.doesNotMatch(output, /!\(i_x_val\)/);
});
