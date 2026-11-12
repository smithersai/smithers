import { describe, expect, it } from "vitest"
import ts from "typescript"
import { fileURLToPath } from "node:url"
import { analyze, specifiers } from "../src/ImportAnalysis.ts"

/** The references of one source, one line each: `<line> <form> <specifier>[ type]`. */
const references = (file: string, text: string): ReadonlyArray<string> =>
  analyze(file, text).references.map((reference) =>
    `${reference.line} ${reference.form} ${reference.specifier}${reference.typeOnly ? " type" : ""}`
  )

/** Every name and member of one source: `<line> <specifier> <name>[ via <binding>][ type]`. */
const names = (file: string, text: string): ReadonlyArray<string> =>
  analyze(file, text).references.flatMap((reference) => [
    ...reference.names.map((name) => `${name.line} ${reference.specifier} ${name.name}${name.typeOnly ? " type" : ""}`),
    ...reference.members.map((name) =>
      `${name.line} ${reference.specifier} ${name.name} via ${name.binding}${name.typeOnly ? " type" : ""}`
    )
  ])

const calls = (file: string, text: string): ReadonlyArray<string> =>
  analyze(file, text).calls.map((call) => `${call.line} ${call.callee}`)

describe("analyze: module references", () => {
  it("reads every declaration form, with its line and whether it is type-only", () => {
    const text = [
      "import React, { useState as useLocal, type FC } from \"react\"",
      "import type { Schema } from \"effect\"",
      "import * as Effect from \"effect/Effect\"",
      "import \"./styles.css\"",
      "export { Button, type ButtonProps } from \"@smthrs/ui\"",
      "export type { Model } from \"@smthrs/model\"",
      "export * from \"./all.ts\"",
      "export * as Flow from \"@smthrs/flow\"",
      "export { local }",
      "import fs = require(\"node:fs\")",
      "import type Types = require(\"./types\")",
      "const local = 1"
    ].join("\n")
    expect(references("a.ts", text)).toEqual([
      "1 import react",
      "2 import effect type",
      "3 import effect/Effect",
      "4 import ./styles.css",
      "5 export @smthrs/ui",
      "6 export @smthrs/model type",
      "7 export ./all.ts",
      "8 export @smthrs/flow",
      "10 import-equals node:fs",
      "11 import-equals ./types type"
    ])
    expect(names("a.ts", text)).toEqual([
      "1 react default",
      "1 react useState",
      "1 react FC type",
      "2 effect Schema type",
      "5 @smthrs/ui Button",
      "5 @smthrs/ui ButtonProps type",
      "6 @smthrs/model Model type"
    ])
  })

  it("reads import(), require() and import() types, and only with one string argument", () => {
    const text = [
      "const a = await import(\"inngest\")",
      "const b = await import(`ai`)",
      "const c = await import(name)",
      "const d = require(\"@temporalio/client\")",
      "const e = require(name)",
      "const f = require(\"x\", \"y\")",
      "const g = load(\"not-a-require\")",
      "const h = registry.require(\"not-a-require\")",
      "type I = typeof import(\"@langchain/langgraph\")",
      "type J = import(\"@alchemy.run/cloudflare\").Workflows.Workflow",
      "type K = import(42)",
      "type L = import(Name)"
    ].join("\n")
    expect(references("b.ts", text)).toEqual([
      "1 dynamic-import inngest",
      "2 dynamic-import ai",
      "4 require @temporalio/client",
      "9 import-type @langchain/langgraph type",
      "10 import-type @alchemy.run/cloudflare type"
    ])
    expect(names("b.ts", text)).toEqual(["10 @alchemy.run/cloudflare Workflows type"])
  })

  it("lists references in source order, and reads imports nested in an ambient module", () => {
    const text = [
      "const early = import(\"early\")",
      "import late from \"late\"",
      "declare module \"ambient\" {",
      "  import inner from \"inner\"",
      "  import other = require(\"other\")",
      "}"
    ].join("\n")
    expect(references("c.ts", text)).toEqual([
      "1 dynamic-import early",
      "2 import late",
      "4 import inner",
      "5 import-equals other"
    ])
  })

  it("skips a declaration whose module is not a string", () => {
    expect(references("d.ts", ["import x from 42", "export * from 42", "import y = require(42)"].join("\n")))
      .toEqual([])
  })

  it("does not read a string or comment that mentions an import", () => {
    const text = [
      "const needle = \"import { generateText } from \\\"ai\\\"\"",
      "const quoted = `await import(\"inngest\")`",
      "// await import(\"@temporalio/client\")",
      "/** Unlike `require(\"langchain\")`. */",
      "export const ok = 1"
    ].join("\n")
    expect(analyze("e.ts", text).references).toEqual([])
  })
})

describe("analyze: members through a binding", () => {
  it("reads names off namespace, default and require bindings, types included, wherever they appear", () => {
    const text = [
      "function early() { return Workers.WorkflowEntrypoint }",
      "import * as Workers from \"cloudflare:workers\"",
      "import React from \"react\"",
      "import Lib = require(\"lib\")",
      "const [state] = React.useState(0)",
      "let node: React.ReactNode",
      "const x = Lib.make?.()",
      "const y = other.useState",
      "type Z = typeof React.useEffect"
    ].join("\n")
    expect(names("f.tsx", text)).toEqual([
      "1 cloudflare:workers WorkflowEntrypoint via Workers",
      "3 react default",
      "5 react useState via React",
      "6 react ReactNode via React type",
      "9 react useEffect via React type",
      "7 lib make via Lib"
    ])
  })
})

describe("analyze: calls", () => {
  it("records a call whose callee is a dotted name, without parentheses, assertions or optional chaining", () => {
    const text = [
      "class Answer extends Base {",
      "  #secret() {}",
      "  run() {",
      "    super.run()",
      "    this.#secret()",
      "    this.client.send()",
      "    ;(model.stream)(request)",
      "    model!.stream(request)",
      "    model?.stream(request)",
      "    Model.stream(request)",
      "    make()()",
      "    table[key]()",
      "    connect().send()",
      "    require(\"lib\")",
      "    import(\"lazy\")",
      "    new Thing()",
      "  }",
      "}"
    ].join("\n")
    expect(calls("g.ts", text)).toEqual([
      "4 super.run",
      "5 this.#secret",
      "6 this.client.send",
      "7 model.stream",
      "8 model.stream",
      "9 model.stream",
      "10 Model.stream",
      "11 make",
      "13 connect().send",
      "13 connect",
      "14 require"
    ])
  })

  it("renders a call receiver as `()`, a string key as a member, a cast as its operand, and any other receiver as `(…)`", () => {
    const text = [
      "async function run() {",
      "  page.context().route(handler)",
      "  make()().send()",
      "  page[\"route\"](handler)",
      "  page?.[`route`](handler)",
      "  headers[\"content-type\"]()",
      "  ;(await open()).route(handler)",
      "  table[key].route(handler)",
      "  rows[0].send()",
      "  new Page().route(handler)",
      "  handlers[0]()",
      "  ;(page as Page).route(handler)",
      "  ;(page satisfies Page).route(handler)",
      "  ;(<Page>page).route(handler)",
      "  page.context()!.route(handler)",
      "}"
    ].join("\n")
    expect(calls("k.ts", text)).toEqual([
      "2 page.context().route",
      "2 page.context",
      "3 make()().send",
      "3 make",
      "4 page.route",
      "5 page.route",
      "6 headers[\"content-type\"]",
      "7 (…).route",
      "7 open",
      "8 (…).route",
      "9 (…).send",
      "10 (…).route",
      "12 page.route",
      "13 page.route",
      "14 page.route",
      "15 page.context().route",
      "15 page.context"
    ])
  })
})

describe("analyze: script kinds", () => {
  it("parses .tsx and .jsx with JSX, .ts, .mts and .cts as TypeScript, and the rest as JavaScript", () => {
    const jsx = "import { Button } from \"@smthrs/ui\"\nexport const View = () => <Button onClick={() => save()} />"
    expect(references("h.tsx", jsx)).toEqual(["1 import @smthrs/ui"])
    expect(calls("h.tsx", jsx)).toEqual(["2 save"])
    expect(references("h.jsx", jsx)).toEqual(["1 import @smthrs/ui"])
    // A generic arrow function is TypeScript, and JSX in a .tsx file.
    const generic = "import { pipe } from \"effect\"\nconst id = <T,>(value: T): T => pipe(value)"
    for (const file of ["i.ts", "i.mts", "i.cts"]) expect(calls(file, generic)).toEqual(["2 pipe"])
    expect(references("i.js", "const fs = require(\"node:fs\")\nfs.readFileSync(\"x\")")).toEqual(["1 require node:fs"])
  })

  it("parses .vibe as TypeScript, whose import syntax VibeLang shares, past VibeLang's own declarations", () => {
    const vibe = [
      "import type { Flow } from \"@smthrs/core/Flow\"",
      "import * as Route from \"./Route.vibe\"",
      "import { record } from \"./internal/Boundary.ts\"",
      "",
      "error NotFound { path: string }",
      "",
      "type SchemaModule = typeof import(\"effect/Schema\")",
      "",
      "export function resolve(path: string): Route.Route!NotFound {",
      "  const route = Route.lookup<Flow>(path) catch (e) => match (e) {",
      "    when Route.Missing: throw new NotFound({ path });",
      "  }",
      "  record(route)",
      "  return route",
      "}"
    ].join("\n")
    expect(references("Resolve.vibe", vibe)).toEqual([
      "1 import @smthrs/core/Flow type",
      "2 import ./Route.vibe",
      "3 import ./internal/Boundary.ts",
      "7 import-type effect/Schema type"
    ])
    // A generic call is lost when the file parses as JavaScript.
    expect(calls("Resolve.vibe", vibe)).toEqual(expect.arrayContaining(["10 Route.lookup", "13 record"]))
  })
})

describe("specifiers", () => {
  it("lists each module once, sorted", () => {
    expect(specifiers(analyze("j.ts", "import \"b\"\nimport \"a\"\nconst lazy = import(\"b\")"))).toEqual(["a", "b"])
  })
})

describe("analyze: a .vibe module and its .ts twin", () => {
  const typescript = [
    "import { Effect } from \"effect\"",
    "import * as Route from \"./Route.ts\"",
    "import type { Model } from \"@smthrs/model\"",
    "export { Button, type ButtonProps } from \"@smthrs/ui\"",
    "export * from \"./More.ts\"",
    "type Deep = import(\"./Deep.ts\").Deep",
    "type Named = Route.Named",
    "export const load = Effect.gen(function* () {",
    "  const route = yield* Route.lookup(\"a\")",
    "  yield* (yield* Users).find(route)",
    "  const lazy = yield* Effect.promise(() => import(\"./Lazy.ts\"))",
    "  yield* record(lazy, () => helper.run())",
    "  return require(\"./old.cjs\")",
    "})"
  ].join("\n")
  const vibe = [
    "import { Effect } from \"effect\"",
    "import * as Route from \"./Route.ts\"",
    "import type { Model } from \"@smthrs/model\"",
    "export { Button, type ButtonProps } from \"@smthrs/ui\"",
    "export * from \"./More.ts\"",
    "type Deep = import(\"./Deep.ts\").Deep",
    "type Named = Route.Named",
    "export effect function load() {",
    "  const route = try Route.lookup(\"a\")",
    "  try (try Users).find(route)",
    "  const lazy = try Effect.promise(() => import(\"./Lazy.ts\"))",
    "  try record(lazy, () => helper.run())",
    "  return require(\"./old.cjs\")",
    "}"
  ].join("\n")

  it("finds the same references, names and members", () => {
    expect(references("Load.vibe", vibe)).toEqual(references("Load.ts", typescript))
    expect(names("Load.vibe", vibe)).toEqual(names("Load.ts", typescript))
  })

  it("finds the same calls; only Effect.gen is TypeScript's spelling of effect", () => {
    expect(calls("Load.vibe", vibe)).toEqual(calls("Load.ts", typescript).filter((call) => !call.endsWith("Effect.gen")))
  })

  it("reads calls inside VibeLang's own forms: try, catch, provide, effect blocks and try.all", () => {
    const text = [
      "export effect function run() {",
      "  const a = try first() catch () => fallback()",
      "  provide Live { try second() }",
      "  try.all [third(), fourth()]",
      "  return effect { try fifth() }",
      "}"
    ].join("\n")
    expect(calls("Run.vibe", text)).toEqual(["2 first", "2 fallback", "3 second", "4 third", "4 fourth", "5 fifth"])
  })

  it.each([
    "import x = require(\"y\")",
    "import type z = require(\"w\")",
    "import { \"a-b\" as c } from \"q\"",
    "import { type T, U } from \"mixed\"\nU.read",
    "const n = require(`t`)",
    "import(\"a\", { with: { type: \"json\" } })",
    "import(`b`)",
    "import(specifier)",
    "x.f[\"g\"]()",
    "x.f[\"a-b\"]()",
    "x[y]()",
    "f()()",
    "(a as any).run()",
    "a!.run()",
    "a?.run()",
    "this.run()",
    "class K extends B { #p() {} m() { this.#p(); super.m() } }",
    "(await p).q()",
    "export type * from \"./t.ts\"",
    "export * as all from \"./t.ts\"",
    "type U = import(\"./u.ts\")",
    "type V = import(\"./u.ts\").A.B",
    "import * as z from \"z\"\nz.a.b\nconst q: z.T = 1",
    "new F()",
    "tag`x`",
    "other.read",
    "import D from \"d\"\nD.read",
    "page.context().route()",
    "export { \"a-b\" as c } from \"x\""
  ])("reads the same facts as TypeScript from %s", (text) => {
    expect(analyze("Form.vibe", text)).toEqual(analyze("Form.ts", text))
  })

  it("reads a module declaration's imports, which only VibeLang has", () => {
    const text = ["module text {", "  import { a } from \"inner\"", "  import x = require(\"old\")", "  export const b = a", "}"].join("\n")
    expect(references("Mod.vibe", text)).toEqual(["2 import inner", "3 import-equals old"])
  })

  it("reports a .vibe syntax error instead of losing what follows it", () => {
    expect(() => analyze("Broken.vibe", "export effect function broken( {")).toThrow()
  })
})

it("carries the parser contract into an isolated downstream TypeScript program", () => {
  const program = ts.createProgram({
    rootNames: [fileURLToPath(new URL("../src/ImportAnalysis.ts", import.meta.url))],
    options: {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      allowImportingTsExtensions: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: []
    }
  })
  expect(ts.getPreEmitDiagnostics(program).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
}, 30_000)
