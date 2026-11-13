import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Compose from "@smthrs/targets/Compose"
import { Filegroup } from "@smthrs/targets/Filegroup"
import { file, glob } from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { layerNonInteractiveNodeServices } from "../src/engine.ts"
import { CheckFilesDifferenceLive, ImportClosureLive } from "../src/Resolver.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

/** Executes one directly-constructed target through the resolver layers. */
const run = (target: Target.AnyTarget) => {
  const flow = Flow.make("resolver-test", {
    payload: {},
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: () => Target.plan(target) as Node.Node<unknown, unknown, never>
  })
  const runtime = Layer.mergeAll(
    ImportClosureLive({ workspaceRoot: root }),
    CheckFilesDifferenceLive({ workspaceRoot: root }),
    Target.layerNotImplemented,
    Interpreter.layer(flow)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(layerNonInteractiveNodeServices)
  )
  return Effect.runPromiseExit(
    flow.execute(Target.metadata(target).attrs as {}, { executionId: "resolver-test" }).pipe(
      Effect.provide(runtime)
    )
  )
}

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) throw new Error("expected the flow to fail")
  const fail = Cause.findFail(exit.cause)
  if (Result.isSuccess(fail)) return fail.success.error
  throw new Error(`expected a typed failure: ${Cause.pretty(exit.cause)}`)
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-resolver-compose-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("S.ImportClosure execution", () => {
  it("computes the closure of glob entries through the layer", async () => {
    await write("src/entry.ts", `import "./a"\nimport "left-pad"\n`)
    await write("src/a.ts", `export const a = 1\n`)
    await write("node_modules/left-pad/package.json", JSON.stringify({ name: "left-pad", main: "index.js" }))
    const target = Compose.ImportClosure({ entries: glob("src/entry.ts") })
    const exit = await run(target)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(Exit.isSuccess(exit) ? exit.value : undefined).toEqual({
      files: [
        { path: "src/a.ts", digest: expect.any(String) },
        { path: "src/entry.ts", digest: expect.any(String) }
      ],
      packages: ["left-pad"],
      unresolved: [],
      dynamic: []
    })
  })

  it("refuses loudly when an entry target kind has no lane yet", async () => {
    const target = Compose.ImportClosure({ entries: Compose.Clean({}) })
    const failure = failureOf(await run(target)) as Target.NotImplemented
    expect(failure._tag).toBe("smithers-build/NotImplemented")
    expect(failure.message).toContain("ImportClosure")
    expect(failure.message).toContain("cannot provide entry files yet")
  })

  it("treats an unmatched glob entry as empty", async () => {
    await write("src/present.ts", `export const present = 1\n`)
    const target = Compose.ImportClosure({
      entries: [glob("src/present.ts"), glob("src/absent.ts")]
    })
    const exit = await run(target)
    expect(Exit.isSuccess(exit) ? exit.value : undefined).toEqual({
      files: [{ path: "src/present.ts", digest: expect.any(String) }],
      packages: [],
      unresolved: [],
      dynamic: []
    })
  })

  it("fails when a declared file entry does not exist", async () => {
    const target = Compose.ImportClosure({ entries: file("src/absent.ts") })
    const failure = failureOf(await run(target)) as Compose.ImportClosureError
    expect(failure._tag).toBe("smithers-build/ImportClosureError")
    expect(failure.message).toContain("declared entry file does not exist: src/absent.ts")
  })
})

describe("S.Test({expect: S.Files.difference, toBe: \"empty\"}) execution", () => {
  it("passes when every declared file is reachable from the entries", async () => {
    await write("src/entry.ts", `import "./a"\nimport "./b"\n`)
    await write("src/a.ts", `export const a = 1\n`)
    await write("src/b.ts", `export const b = 1\n`)
    const universe = Filegroup({ srcs: [glob("src/**/*.ts")] })
    const closure = Compose.ImportClosure({ entries: glob("src/entry.ts") })
    const target = Compose.Test({
      expect: Compose.Files.difference(universe, closure),
      toBe: "empty"
    })
    const exit = await run(target)
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  it("fails with the dead files as leftover rows", async () => {
    await write("src/entry.ts", `import "./a"\n`)
    await write("src/a.ts", `export const a = 1\n`)
    await write("src/dead.ts", `export const dead = 1\n`)
    const universe = Filegroup({ srcs: [glob("src/**/*.ts")] })
    const closure = Compose.ImportClosure({ entries: glob("src/entry.ts") })
    const target = Compose.Test({
      expect: Compose.Files.difference(universe, closure),
      toBe: "empty"
    })
    const failure = failureOf(await run(target)) as Compose.FilesTestError
    expect(failure._tag).toBe("smithers-build/FilesTestError")
    expect(failure.leftover).toEqual(["src/dead.ts"])
  })

  it("fails closed when the closure contains a dynamic import", async () => {
    await write("src/entry.ts", `const name = "a"\nexport const load = () => import("./" + name)\n`)
    const universe = Filegroup({ srcs: [glob("src/**/*.ts")] })
    const closure = Compose.ImportClosure({ entries: glob("src/entry.ts") })
    const target = Compose.Test({
      expect: Compose.Files.difference(universe, closure),
      toBe: "empty"
    })
    const failure = failureOf(await run(target)) as Compose.FilesTestError
    expect(failure._tag).toBe("smithers-build/FilesTestError")
    expect(failure.leftover).toEqual([])
    expect(failure.dynamic).toEqual([{ file: "src/entry.ts", specifier: `"./" + name` }])
    expect(failure.message).toContain("fails closed")
  })

  it("fails closed when the closure contains an unresolved import", async () => {
    await write("src/entry.ts", `import "./gone"\n`)
    const universe = Filegroup({ srcs: [glob("src/**/*.ts")] })
    const closure = Compose.ImportClosure({ entries: glob("src/entry.ts") })
    const target = Compose.Test({
      expect: Compose.Files.difference(universe, closure),
      toBe: "empty"
    })
    const failure = failureOf(await run(target)) as Compose.FilesTestError
    expect(failure._tag).toBe("smithers-build/FilesTestError")
    expect(failure.unresolved).toEqual([{ file: "src/entry.ts", specifier: "./gone" }])
  })

  it("refuses loudly for operand target kinds no lane implements yet", async () => {
    const universe = Filegroup({ srcs: [glob("src/**/*.ts")] })
    const target = Compose.Test({
      expect: Compose.Files.difference(Compose.Clean({}), universe),
      toBe: "empty"
    })
    const failure = failureOf(await run(target)) as Target.NotImplemented
    expect(failure._tag).toBe("smithers-build/NotImplemented")
    expect(failure.message).toContain("does not expose a resolvable file set yet")
  })
})
