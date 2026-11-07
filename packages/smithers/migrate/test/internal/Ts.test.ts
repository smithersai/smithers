import * as Effect from "effect/Effect"
import * as ts from "typescript/unstable/ast"
import { API } from "typescript/unstable/sync"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Ts from "../../src/internal/Ts.ts"
import * as Scan from "../../src/Scan.ts"
import { copyFixture, nodeLayer } from "../fixtures/helpers.ts"

const counts = vi.hoisted(() => ({ opens: 0, closes: 0, snapshots: 0 }))
vi.mock("typescript/unstable/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("typescript/unstable/sync")>()
  return {
    ...actual,
    API: class extends actual.API {
      constructor(...args: ConstructorParameters<typeof actual.API>) {
        super(...args)
        counts.opens++
      }
      override updateSnapshot(...args: Parameters<InstanceType<typeof actual.API>["updateSnapshot"]>) {
        counts.snapshots++
        return super.updateSnapshot(...args)
      }
      override close() {
        counts.closes++
        super.close()
      }
    }
  }
})

beforeEach(() => {
  counts.opens = 0
  counts.closes = 0
  counts.snapshots = 0
})
afterEach(() => vi.restoreAllMocks())

describe("scan compiler session", () => {
  it("opens one compiler for a multi-file scan and reuses source trees between passes", async () => {
    const imports = vi.spyOn(Ts, "imports")
    const traversals = vi.spyOn(Ts, "forEachNode")
    const result = await Effect.runPromise(Scan.scan(copyFixture("jsx-single")).pipe(Effect.provide(nodeLayer)))
    expect(result.detection.sources.size).toBeGreaterThan(1)
    expect(counts.opens).toBe(1)
    expect(counts.closes).toBe(1)
    const workflow = result.detection.sources.get("simple-workflow.jsx")!
    const passes = imports.mock.calls.map(([source]) => source).filter((source) => source.text === workflow)
    expect(passes.length).toBeGreaterThan(1)
    expect(new Set(passes).size).toBe(1)
    const walks = traversals.mock.calls.map(([node]) => node).filter((node) =>
      ts.isSourceFile(node) && node.text === workflow
    )
    expect(walks.length).toBeGreaterThan(1)
    expect(new Set([...passes, ...walks]).size).toBe(1)
  })

  it("still closes an isolated parse before returning a usable tree", () => {
    const source = Ts.parse("flow.tsx", "import { Task } from \"smthrs\"; const task = <Task />")
    expect(counts).toEqual({ opens: 1, closes: 1, snapshots: 1 })
    expect(Ts.imports(source)[0]?.specifier).toBe("smthrs")
    expect(source.statements[1]?.getText()).toContain("<Task />")
  })

  it("caches by both path and content, including expressions and extension changes", async () => {
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
      }).pipe(Effect.scoped)
    )
    expect(counts.closes).toBe(1)
  })

  it("releases on scan failure", async () => {
    await Effect.runPromise(Effect.flip(
      Scan.scan(copyFixture("jsx-single"), { units: ["missing"] }).pipe(Effect.provide(nodeLayer))
    ))
    expect(counts.opens).toBe(1)
    expect(counts.closes).toBe(1)
  })

  it("releases on a compiler defect", async () => {
    vi.spyOn(API.prototype, "updateSnapshot").mockImplementationOnce(() => {
      throw new Error("compiler failed")
    })
    await expect(Effect.runPromise(
      Scan.scan(copyFixture("jsx-single")).pipe(Effect.provide(nodeLayer))
    )).rejects.toThrow("compiler failed")
    expect(counts.opens).toBe(1)
    expect(counts.closes).toBe(1)
  })

  it("releases on interruption and rejects a parser retained past its scope", async () => {
    let retained: typeof Ts.parse | undefined
    await Effect.runPromise(
      Effect.gen(function*() {
        retained = yield* Ts.session
        retained("flow.ts", "const a = 1")
        return yield* Effect.interrupt
      }).pipe(Effect.scoped, Effect.exit)
    )
    expect(counts.closes).toBe(1)
    expect(() => retained!("flow.ts", "const a = 1")).toThrow("session is closed")
  })

  it("isolates trees between sessions", async () => {
    const tree = () =>
      Effect.gen(function*() {
        const parse = yield* Ts.session
        return parse("flow.ts", "const a = 1")
      }).pipe(Effect.scoped)
    const first = await Effect.runPromise(tree())
    const second = await Effect.runPromise(tree())
    expect(first).not.toBe(second)
    expect(first.text).toBe(second.text)
    expect(counts).toEqual({ opens: 2, closes: 2, snapshots: 2 })
  })

  it("keeps concurrent scans independent", async () => {
    const roots = [copyFixture("jsx-single"), copyFixture("jsx-single")]
    const results = await Promise.all(roots.map((root) =>
      Effect.runPromise(
        Scan.scan(root).pipe(Effect.provide(nodeLayer))
      )
    ))
    expect(results.map((result) => result.root)).toEqual(roots)
    expect(results[0]?.inventory).toEqual(results[1]?.inventory)
    expect(counts.opens).toBe(2)
    expect(counts.closes).toBe(2)
  })
})
