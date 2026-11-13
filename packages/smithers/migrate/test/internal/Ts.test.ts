import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { API } from "typescript/unstable/sync"
import { describe, expect, it } from "vitest"
import * as Ts from "../../src/internal/Ts.ts"
import * as Scan from "../../src/Scan.ts"
import { copyFixture, nodeLayer } from "../fixtures/helpers.ts"

/** Records real native compiler operations through the injected service. */
const observedCompiler = () => {
  const counts = { opens: 0, closes: 0, snapshots: 0 }
  const inputs: Array<string> = []
  const compiler: Ts.CompilerService = {
    open: (options) => {
      const api = new API(options)
      counts.opens++
      return {
        clearSourceFileCache: () => api.clearSourceFileCache(),
        updateSnapshot: (changes) => {
          const config = JSON.parse(options.fs!.readFile!(`${options.cwd}/tsconfig.json`)!) as { files: Array<string> }
          inputs.push(options.fs!.readFile!(`${options.cwd}/${config.files[0]}`)!)
          counts.snapshots++
          return api.updateSnapshot(changes)
        },
        close: () => {
          api.close()
          counts.closes++
        }
      }
    }
  }
  return { counts, compiler, inputs }
}

describe("scan compiler session", () => {
  it("opens one compiler for a multi-file scan and reuses source trees between passes", async () => {
    const { counts, compiler, inputs } = observedCompiler()
    const result = await Effect.runPromise(
      Scan.scan(copyFixture("jsx-single")).pipe(
        Effect.provide(nodeLayer),
        Effect.provideService(Ts.Compiler, compiler)
      )
    )
    expect(result.detection.sources.size).toBeGreaterThan(1)
    expect(counts.opens).toBe(1)
    expect(counts.closes).toBe(1)
    // Synthetic expression inputs also use the compiler. Count the original
    // workflow itself, which multiple scanner passes inspect.
    const workflow = result.detection.sources.get("simple-workflow.jsx")!
    expect(inputs.filter((text) => text === workflow)).toHaveLength(1)
    expect(result.inventory.some((entry) => entry.construct === "Task")).toBe(true)
  })

  it("still returns a usable tree from an isolated parse", () => {
    const source = Ts.parse("flow.tsx", "import { Task } from \"smthrs\"; const task = <Task />")
    expect(Ts.imports(source)[0]?.specifier).toBe("smthrs")
    expect(source.statements[1]?.getText()).toContain("<Task />")
  })

  it("caches by both path and content, including expressions and extension changes", async () => {
    const { counts, compiler } = observedCompiler()
    await Effect.runPromise(
      Effect.gen(function*() {
        const parse = yield* Ts.session
        const first = parse("flow.ts", "const a = 1")
        expect(parse("flow.ts", "const a = 1")).toBe(first)
        const jsx = parse("view.tsx", "const view = <Task />")
        expect(jsx.statements[0]?.getText()).toBe("const view = <Task />")
        const changed = parse("flow.ts", "const a = 2")
        expect(changed).not.toBe(first)
        expect(changed.text).toBe("const a = 2")
        const other = parse("other.ts", "const a = 2")
        expect(other).not.toBe(changed)
        expect(other.text).toBe(changed.text)
        const expression = parse("chain.ts", "const value = z.string()")
        expect(parse("chain.ts", "const value = z.string()")).toBe(expression)
        expect(parse("flow.ts", "const a = 1")).toBe(first)
        expect(first.text).toBe("const a = 1")
        expect(counts).toEqual({ opens: 1, closes: 0, snapshots: 5 })
      }).pipe(Effect.scoped, Effect.provideService(Ts.Compiler, compiler))
    )
    expect(counts.closes).toBe(1)
  })

  it("releases on scan failure", async () => {
    const { counts, compiler } = observedCompiler()
    await Effect.runPromise(Effect.flip(
      Scan.scan(copyFixture("jsx-single"), { units: ["missing"] }).pipe(
        Effect.provide(nodeLayer),
        Effect.provideService(Ts.Compiler, compiler)
      )
    ))
    expect(counts.opens).toBe(1)
    expect(counts.closes).toBe(1)
  })

  it("releases on a compiler defect", async () => {
    const { counts, compiler } = observedCompiler()
    const failure = new Error("compiler failed")
    const faulty: Ts.CompilerService = {
      open: (options) => {
        const api = compiler.open(options)
        return {
          ...api,
          updateSnapshot: () => {
            throw failure
          }
        }
      }
    }
    const exit = await Effect.runPromise(
      Scan.scan(copyFixture("jsx-single")).pipe(
        Effect.provide(nodeLayer),
        Effect.provideService(Ts.Compiler, faulty),
        Effect.exit
      )
    )
    expect(exit).toEqual(expect.objectContaining({ _tag: "Failure" }))
    if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBe(failure)
    expect(counts.opens).toBe(1)
    expect(counts.closes).toBe(1)
  })

  it("releases on interruption and rejects a parser retained past its scope", async () => {
    const { counts, compiler } = observedCompiler()
    let retained: typeof Ts.parse | undefined
    await Effect.runPromise(
      Effect.gen(function*() {
        retained = yield* Ts.session
        retained("flow.ts", "const a = 1")
        return yield* Effect.interrupt
      }).pipe(Effect.scoped, Effect.provideService(Ts.Compiler, compiler), Effect.exit)
    )
    expect(counts.closes).toBe(1)
    expect(() => retained!("flow.ts", "const a = 1")).toThrow("session is closed")
  })

  it("isolates trees between sessions", async () => {
    const { counts, compiler } = observedCompiler()
    const tree = () =>
      Effect.gen(function*() {
        const parse = yield* Ts.session
        return parse("flow.ts", "const a = 1")
      }).pipe(Effect.scoped, Effect.provideService(Ts.Compiler, compiler))
    const first = await Effect.runPromise(tree())
    const second = await Effect.runPromise(tree())
    expect(first).not.toBe(second)
    expect(first.text).toBe(second.text)
    expect(counts).toEqual({ opens: 2, closes: 2, snapshots: 2 })
  })

  it("keeps concurrent scans independent", async () => {
    const { counts, compiler } = observedCompiler()
    const roots = [copyFixture("jsx-single"), copyFixture("jsx-single")]
    const results = await Promise.all(roots.map((root) =>
      Effect.runPromise(
        Scan.scan(root).pipe(Effect.provide(nodeLayer), Effect.provideService(Ts.Compiler, compiler))
      )
    ))
    expect(results.map((result) => result.root)).toEqual(roots)
    expect(results[0]?.inventory).toEqual(results[1]?.inventory)
    expect(counts.opens).toBe(2)
    expect(counts.closes).toBe(2)
  })
})
