import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Project, ScriptTarget } from "ts-morph";
import { extractModule } from "../src/extract.ts";
import { resolveModule } from "../src/resolve.ts";
import { narrowModule } from "../src/narrow.ts";
import { transformModuleDafny } from "../src/transform.ts";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import { resolveOptions } from "../src/config.ts";

// An Effect Schema model (`fixtures/schema-model`) is translated through the value type the checker resolves, in the
// two forms a program reaches it: the schema's source, and the declaration an emitter writes for it (`declare const
// Model: Schema.Struct<{ readonly account: Schema.optionalKey<…> }>`), which is how a proved module imports a type
// from a module outside the verifiable subset.
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/schema-model");

function emitFile(project: Project, path: string): string {
  const source = project.getSourceFileOrThrow(path);
  assert.deepEqual(project.getPreEmitDiagnostics().map(d => d.getMessageText()), [], "the fixture must be valid TypeScript");
  const { typesFile, defFile } = transformModuleDafny(narrowModule(resolveModule(extractModule(source))));
  return emitDafnyFile({ ...defFile, decls: [...(typesFile?.decls ?? []), ...defFile.decls] },
    path, resolveOptions({ "dafny-library": "local" }, "test"));
}

function fromSource(file: string): string {
  const project = new Project({ tsConfigFilePath: join(fixture, "tsconfig.json"), skipAddingFilesFromTsConfig: true });
  project.addSourceFileAtPath(join(fixture, file));
  project.resolveSourceFileDependencies();
  return emitFile(project, join(fixture, file));
}

/** `use.ts` over the declaration TypeScript emits for `model.ts`, in a folder inside the package so `effect` resolves. */
function fromDeclaration(): { dafny: string; declaration: string } {
  const emitter = new Project({ tsConfigFilePath: join(fixture, "tsconfig.json"), skipAddingFilesFromTsConfig: true,
    compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true } });
  emitter.addSourceFileAtPath(join(fixture, "model.ts"));
  const declaration = emitter.emitToMemory({ emitOnlyDtsFiles: true }).getFiles()[0]!.text;
  const folder = mkdtempSync(join(fixture, "..", ".schema-declared-"));
  try {
    writeFileSync(join(folder, "model.d.ts"), declaration);
    writeFileSync(join(folder, "use.ts"), readFileSync(join(fixture, "use.ts"), "utf8"));
    writeFileSync(join(folder, "tsconfig.json"), readFileSync(join(fixture, "tsconfig.json"), "utf8"));
    const project = new Project({ tsConfigFilePath: join(folder, "tsconfig.json"), skipAddingFilesFromTsConfig: true });
    project.addSourceFileAtPath(join(folder, "use.ts"));
    project.resolveSourceFileDependencies();
    return { dafny: emitFile(project, join(folder, "use.ts")), declaration };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function assertModel(dafny: string): void {
  assert.doesNotMatch(dafny, /__type|__object|Schema\.|Brand|Opaque/, "no schema or anonymous type text reaches Dafny");
  assert.match(dafny, /^datatype ModelStatus = Idle \| Busy\(since: int\)$/m, "a union of tagged structs is a datatype");
  assert.match(dafny, /^datatype ModelAccount = ModelAccount\(name: string, owner: string\)$/m, "a brand is its primitive");
  const model = dafny.split("\n").find(l => l.startsWith("datatype Model = "))!;
  for (const field of ["docs: string", "age: string", "status: ModelStatus", "count: int", "account: Option<ModelAccount>", "review: Option<ModelReview>", "sources: Option<map<string, string>>",
    "seen: Option<seq<string>>"]) {
    assert.ok(model.includes(field), `Model has ${field}: ${model}`);
  }
  // An array of anonymous structs has a named element, and an equal struct elsewhere (`Client.pending`) is the same
  // datatype; both copies of `Client` are one datatype.
  const row = model.match(/rows: seq<(\w+)>/)![1]!;
  assert.match(dafny, new RegExp(`^datatype ${row} = ${row}\\(key: string, at: int\\)$`, "m"));
  // `current` and `previous` are one datatype, and the `Client` alias names it too (`type Client = …` or its record).
  const client = model.match(/current: (\w+)/)![1]!;
  assert.ok(model.includes(`previous: ${client}`), model);
  const entry = dafny.match(new RegExp(`^datatype ${client} = ${client}\\(seq_: int, entries: seq<(\\w+)>, pending: seq<${row}>\\)$`, "m"))![1]!;
  assert.match(dafny, new RegExp(`^datatype ${entry} = ${entry}\\(id: string, done: bool\\)$`, "m"));
  assert.ok(client === "Client" || new RegExp(`^type Client = ${client}$`, "m").test(dafny), "the Client alias is the field's datatype");
  assert.match(dafny, /^function writeDocs\(model: Model, docs: string\): Model$/m, "a function returning the Model returns the Model datatype");
}

test("a schema's value type imported from its source translates through its resolved structure", () => {
  assertModel(fromSource("use.ts"));
});

test("a schema's value type imported from its emitted declaration translates the same as from its source", () => {
  const { dafny, declaration } = fromDeclaration();
  assert.match(declaration, /readonly account: Schema\.optionalKey<Schema\.Struct<\{/, "the declaration states schema types");
  assertModel(dafny);
});

test("a schema declared beside the proof stays out of the model; only its value type is translated", () => {
  const dafny = fromSource("local.ts");
  assert.match(dafny, /^datatype Panel = Panel\(docs: string, rows: seq<PanelRowsItem>, note: Option<string>\)$/m);
  assert.doesNotMatch(dafny, /Schema|Struct|Literals/);
});

function emit(text: string): string {
  const project = new Project({ compilerOptions: { strict: true, exactOptionalPropertyTypes: true,
    target: ScriptTarget.ESNext, lib: ["lib.esnext.d.ts"], types: [], skipLibCheck: true } });
  project.createSourceFile("page.ts", text);
  return emitFile(project, "page.ts");
}

test("a synthesized name never takes a name the module declares, wherever it is declared", () => {
  const output = emit("type Panel = { readonly rows: ReadonlyArray<{ readonly key: string }> }\n"
    + "interface PanelRowsItem { readonly other: number }\n"
    + "//@ verify\nexport function f(p: Panel, q: PanelRowsItem): Panel { return p; }");
  assert.match(output, /^datatype PanelRowsItem = PanelRowsItem\(other: int\)$/m);
  assert.match(output, /^datatype PanelRowsItem2 = PanelRowsItem2\(key: string\)$/m);
  assert.match(output, /^datatype Panel = Panel\(rows: seq<PanelRowsItem2>\)$/m);
});

test("a synthesized datatype of a dropped declaration is synthesized again where a kept type reaches it", () => {
  const output = emit("type Unused = { readonly rows: ReadonlyArray<{ readonly k: number }> }\n"
    + "//@ verify\nexport function f(n: number): { readonly rows: ReadonlyArray<{ readonly k: number }> } { return { rows: [{ k: n }] }; }");
  assert.doesNotMatch(output, /Unused/);
  assert.match(output, /^datatype FResultRowsItem = FResultRowsItem\(k: int\)$/m);
  assert.match(output, /^datatype FResult = FResult\(rows: seq<FResultRowsItem>\)$/m);
});

test("a named brand is an alias of its primitive, and an untagged union of anonymous structs stays opaque", () => {
  const output = emit("type Owner = string & { readonly brand: \"Owner\" }\n"
    + "type Panel = { readonly owner: Owner; readonly byKey: Record<string, { readonly n: number }>; readonly either: { readonly a: number } | { readonly b: string } }\n"
    + "//@ verify\nexport function f(p: Panel): Panel { return p; }");
  assert.match(output, /^type Owner = string$/m);
  assert.match(output, /^type PanelEither\(==\)$/m);
  assert.match(output, /^datatype PanelByKeyValue = PanelByKeyValue\(n: int\)$/m);
  assert.match(output, /^datatype Panel = Panel\(owner: Owner, byKey: map<string, PanelByKeyValue>, either: PanelEither\)$/m);
});
