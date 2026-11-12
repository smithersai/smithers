import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";

const fixture = readFileSync(new URL("../fixtures/object-spread-operands.ts", import.meta.url), "utf8");

function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  const source = project.createSourceFile("page.ts", text);
  assert.deepEqual(project.getPreEmitDiagnostics(), [], "regressions must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    "page.ts", resolveOptions({ "dafny-library": "local" }, "test"));
}

/** The emitted body of `name`, from its signature to the next blank line. */
function body(output: string, name: string): string {
  const start = output.search(new RegExp(`^(function|method) ${name}\\(`, "m"));
  assert.notEqual(start, -1, `${name} is emitted`);
  return output.slice(start, output.indexOf("\n\n", start));
}

test("a merge calls a base it overwrites entirely, once, before the override", () => {
  const replaced = body(emit(fixture), "replaced");
  assert.equal(replaced.match(/positive\(k\)/g)?.length, 1);
  assert.equal(replaced.match(/constant\(k\)/g)?.length, 1);
  assert.ok(replaced.indexOf("positive(k)") < replaced.indexOf("constant(k)"), replaced);
});

test("a method-valued override is one statement-level call read field by field", () => {
  const recounted = body(emit(fixture), "recounted");
  assert.equal(recounted.match(/counted\(n\)/g)?.length, 1);
  assert.match(recounted, /^ {2}var \w+ := counted\(n\);$/m);
  assert.doesNotMatch(recounted, /counted\(n\)\./);
});

test("a variable operand is read in place", () => {
  const output = emit("type Pair = { readonly a: number; readonly b: number }\n"
    + "//@ verify\nfunction f(p: Pair, q: Pair): Pair { return { ...p, ...q } }");
  assert.doesNotMatch(body(output, "f"), /var /);
});
