import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { createContext, runInContext } from "node:vm"
import vibelang from "vibelang-unplugin/esbuild"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellValidation from "../src/CellValidation.ts"

describe("portable cell compiler", () => {
  it.each([
    "import \"forbidden\"",
    "import x from \"forbidden\"",
    "import x = require(\"forbidden\")",
    "export { x } from \"forbidden\"",
    "export const x = 1",
    "export default 1",
    "export = 1",
    "export as namespace X",
    "await import(\"forbidden\")",
    "function f() { return require(\"forbidden\") }",
    "console.log(import.meta.url)"
  ])("refuses module access without evaluating %s", (text) => {
    const result = CellValidation.validate(Cell.source(text, "typescript"))
    expect(result.rejected?.code).toBe("imports_forbidden")
    expect(result.compiled).toBeUndefined()
  })

  it.each([
    ["enum E { One, Two }", "enum declarations"],
    ["namespace N { export const x = 1 }", "namespace/module declarations"],
    ["class C { constructor(public value: number) {} }", "parameter properties"]
  ])("refuses non-erasable TypeScript: %s", (text, reason) => {
    const result = CellValidation.validate(Cell.source(text, "typescript"))
    expect(result.rejected?.code).toBe("compile_failed")
    expect(result.rejected?.message).toContain(reason)
    expect(result.compiled).toBeUndefined()
  })

  it.each([
    "if (true) { var ctx = 1 }",
    "for (var ctx of [1]) {}",
    "for (var console = 0; console < 1; console++) {}",
    "try { throw 1 } catch (error) { var { console } = source }",
    "if (true) { function ctx() {} }"
  ])("refuses declarations hoisted into the persistent scope: %s", (text) => {
    const result = CellValidation.validate(Cell.source(text))
    expect(result.rejected?.code).toBe("compile_failed")
    expect(result.rejected?.message).toContain("the run's own binding")
    expect(result.compiled).toBeUndefined()
  })

  it.each([
    "if (true) { let ctx = 1 }",
    "for (const console of [1]) {}",
    "function f() { var ctx = 1; function console() {} }",
    "class C { method() { var ctx = 1; return ctx } }",
    "const quoted = \"import x from forbidden\"; const key = { require: 1 }"
  ])("preserves genuinely nested bindings and inert text: %s", (text) => {
    expect(CellValidation.validate(Cell.source(text)).rejected).toBeUndefined()
  })

  it.each(
    [
      ["interface Value { n: number }; const v: Value = { n: 2 }; globalThis.answer = v.n", 2],
      ["type Value = number; const v = 3 satisfies Value; globalThis.answer = v", 3],
      ["const identity = <T>(v: T): T => v; globalThis.answer = identity<number>(4)", 4],
      ["class Box { value: number = 5 }; globalThis.answer = new Box().value", 5]
    ] as const
  )("erases types and preserves executed values: %s", (text, expected) => {
    const result = CellValidation.validate(Cell.source(text, "typescript"))
    expect(result.rejected).toBeUndefined()
    const context = createContext({})
    runInContext(result.compiled!, context, { timeout: 1000 })
    expect(context.answer).toBe(expected)
  })

  it("reports recovered parse errors instead of returning executable text", () => {
    const result = CellValidation.validate(Cell.source("function f() { let x = 1; let x = 2 }"))
    expect(result.rejected?.code).toBe("compile_failed")
    expect(result.rejected?.message).toContain("already been declared")
    expect(result.compiled).toBeUndefined()
  })

  it("allows rebindings only in the top-level scope normalization rewrites", () => {
    const repeated = CellValidation.validate(Cell.source("const x = 1, x = 2, x = 3; let x = 4; globalThis.answer = x"))
    expect(repeated.rejected).toBeUndefined()
    const context = createContext({})
    runInContext(repeated.compiled!, context, { timeout: 1000 })
    expect(context.answer).toBe(4)
    const nested = CellValidation.validate(Cell.source("const f = () => { let x = 1; let x = 2 }"))
    expect(nested.rejected?.code).toBe("compile_failed")
  })

  it("keeps TypeScript strict-script semantics and supports a leading hashbang", () => {
    for (const prefix of ["", "#!/usr/bin/env node\n"]) {
      const result = CellValidation.validate(
        Cell.source(prefix + "function f() { return this }; globalThis.answer = f()", "typescript")
      )
      expect(result.rejected).toBeUndefined()
      const context = createContext({})
      runInContext(result.compiled!, context, { timeout: 1000 })
      expect(Object.hasOwn(context, "answer")).toBe(true)
      expect(context.answer).toBeUndefined()
    }
    expect(CellValidation.validate(Cell.source("#!/usr/bin/env node", "typescript")).rejected).toBeUndefined()
  })

  it("refuses excessive parser nesting and remains usable afterwards", () => {
    const result = CellValidation.validate(Cell.source("(".repeat(20_000) + "0" + ")".repeat(20_000)))
    expect(result.rejected?.code).toBe("compile_failed")
    expect(result.compiled).toBeUndefined()
    expect(CellValidation.validate(Cell.source("const recovered = 1")).compiled).toBe("var recovered = 1")
  })

  it.each(["\r", "\r\n", "\u2028", "\u2029"])("locates errors across the JavaScript line separator %j", (separator) => {
    const result = CellValidation.validate(Cell.source(`const a = 1${separator}const b = )`))
    expect(result.rejected?.message).toBe(
      "The cell did not compile — line 2, column 11: Unexpected token\n  const b = )"
    )
  })

  it("bundles and compiles in a host without Node APIs or document hooks", async () => {
    const entry = fileURLToPath(new URL("../src/CellValidation.ts", import.meta.url))
    const result = await build({
      plugins: [vibelang({ root: fileURLToPath(new URL("../", import.meta.url)) })],
      entryPoints: [entry],
      platform: "browser",
      format: "iife",
      globalName: "Validator",
      bundle: true,
      write: false,
      metafile: true,
      logLevel: "silent"
    })
    expect(Object.values(result.metafile!.outputs).flatMap((output) => output.imports)).toEqual([])
    const context = createContext({
      TextEncoder,
      TextDecoder,
      window: {
        addEventListener: () => {
          throw new Error("a compiler must not register document hooks")
        }
      }
    })
    runInContext(result.outputFiles[0]!.text, context, { timeout: 5000 })
    const compiled = runInContext(
      "Validator.validate({ language: \"typescript\", text: \"const value: number = 7; globalThis.answer = value\" })",
      context,
      { timeout: 5000 }
    ) as CellValidation.Validation
    expect(compiled.rejected).toBeUndefined()
    expect(context.answer).toBeUndefined()
    runInContext(compiled.compiled!, context, { timeout: 1000 })
    expect(context.answer).toBe(7)
    expect(runInContext("[typeof process, typeof require, typeof Buffer]", context)).toEqual([
      "undefined",
      "undefined",
      "undefined"
    ])
  })
})
