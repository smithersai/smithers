import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Compose from "@smthrs/targets/Compose"
import { file, glob } from "@smthrs/targets/Input"
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Target from "@smthrs/targets/Target"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type CacheStore, openCache } from "../src/Cache.ts"
import { layerNonInteractiveNodeServices } from "../src/engine.ts"
import {
  CheckFilesDifferenceLive,
  ClosureError,
  computeClosure,
  ImportClosureLive,
  type LiveOptions,
  loadResolverConfig,
  ResolverConfigError,
  rowCacheKey,
  rowCacheTarget
} from "../src/Resolver.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(() => undefined, (error: unknown) => error)

/** Real filesystem I/O whose lstat of one path reports ENOENT from the given call onward. */
const vanishingIo = (basename: string, fromCall: number): SafeFs.Io => {
  let calls = 0
  return {
    ...SafeFs.defaultIo,
    lstat: (path) => {
      if (NodePath.basename(path) === basename) {
        calls += 1
        if (calls >= fromCall) {
          return Promise.reject(Object.assign(new Error(`ENOENT: no such file, lstat '${path}'`), { code: "ENOENT" }))
        }
      }
      return SafeFs.defaultIo.lstat(path)
    }
  }
}

/** Executes one directly-constructed target through the resolver layers. */
const run = (target: Target.AnyTarget, options: LiveOptions) => {
  const flow = Flow.make("resolver-failure-test", {
    payload: {},
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: () => Target.plan(target) as Node.Node<unknown, unknown, never>
  })
  const runtime = Layer.mergeAll(
    ImportClosureLive(options),
    CheckFilesDifferenceLive(options),
    Target.layerNotImplemented,
    Interpreter.layer(flow)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(layerNonInteractiveNodeServices)
  )
  return Effect.runPromiseExit(
    flow.execute(Target.metadata(target).attrs as {}, { executionId: "resolver-failure-test" }).pipe(
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
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-resolver-failures-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("files vanishing between admission and read", () => {
  it("refuses a module entry that disappears after it was admitted", async () => {
    await write("entry.ts", `export const entry = 1\n`)
    const config = await loadResolverConfig({ workspaceRoot: root })
    const io = vanishingIo("entry.ts", 2)
    const failure = await rejection(computeClosure({ config, entries: ["entry.ts"], io }))
    expect(failure).toBeInstanceOf(ClosureError)
    expect(failure).toMatchObject({ reason: "missing_entry" })
    expect((failure as ClosureError).message).toMatch(
      /^closure entry does not exist: entry\.ts: module \(parse bound\) disappeared: /
    )
  })

  it("refuses a reached module that disappears as unreadable, not missing", async () => {
    await write("entry.ts", `import "./dep"\n`)
    await write("dep.ts", `export const dep = 1\n`)
    const config = await loadResolverConfig({ workspaceRoot: root })
    const failure = await rejection(computeClosure({ config, entries: ["entry.ts"], io: vanishingIo("dep.ts", 2) }))
    expect(failure).toMatchObject({ reason: "unreadable" })
    expect((failure as ClosureError).message).toMatch(/^closure file could not be read: dep\.ts: module/)
  })

  it("refuses a tsconfig that disappears after it was admitted", async () => {
    await write("tsconfig.json", `{"compilerOptions":{}}`)
    const failure = await rejection(loadResolverConfig({ workspaceRoot: root, io: vanishingIo("tsconfig.json", 2) }))
    expect(failure).toBeInstanceOf(ResolverConfigError)
    expect(failure).toMatchObject({ reason: "unreadable" })
    expect((failure as ResolverConfigError).message).toMatch(
      /^tsconfig could not be read: tsconfig\.json: tsconfig disappeared: /
    )
  })

  it("refuses a missing non-module entry", async () => {
    const config = await loadResolverConfig({ workspaceRoot: root })
    const failure = await rejection(computeClosure({ config, entries: ["data.json"] }))
    expect(failure).toMatchObject({
      reason: "missing_entry",
      message: "closure entry does not exist: data.json: file does not exist: data.json"
    })
  })
})

describe("closure bookkeeping", () => {
  it("visits a repeated entry once", async () => {
    await write("entry.ts", `export const entry = 1\n`)
    const config = await loadResolverConfig({ workspaceRoot: root })
    const outcome = await computeClosure({ config, entries: ["entry.ts", "entry.ts"] })
    expect(outcome.result.files.map((entry) => entry.path)).toEqual(["entry.ts"])
    expect(outcome.stats).toEqual({ parsed: 1, cached: 0 })
  })

  it("refuses an entry that normalizes to the workspace root", async () => {
    const config = await loadResolverConfig({ workspaceRoot: root })
    await expect(computeClosure({ config, entries: ["."] })).rejects.toMatchObject({ reason: "invalid_entry" })
  })

  it("counts the controlling imports manifest against the closure size bound", async () => {
    await write("package.json", JSON.stringify({ imports: { "#x": "./x.ts" } }))
    await write("entry.ts", `import "#x"\n`)
    await write("x.ts", `export const x = 1\n`)
    const config = await loadResolverConfig({ workspaceRoot: root })
    await expect(computeClosure({ config, entries: ["entry.ts"], maximumFiles: 1 })).rejects.toMatchObject({
      reason: "too_many_files",
      message: "import closure exceeds 1 files"
    })
    const admitted = await computeClosure({ config, entries: ["entry.ts"], maximumFiles: 3 })
    expect(admitted.result.files.map((entry) => entry.path)).toEqual(["entry.ts", "package.json", "x.ts"])
  })

  it("sorts issues by file even when later files are reached first", async () => {
    await write("z.ts", `import "./a"\nimport "./z-gone"\nimport(z)\n`)
    await write("a.ts", `import "./a-gone"\nimport(a)\n`)
    const config = await loadResolverConfig({ workspaceRoot: root })
    const outcome = await computeClosure({ config, entries: ["z.ts"] })
    expect(outcome.result.files.map((entry) => entry.path)).toEqual(["a.ts", "z.ts"])
    expect(outcome.result.unresolved).toEqual([
      { file: "a.ts", specifier: "./a-gone" },
      { file: "z.ts", specifier: "./z-gone" }
    ])
    expect(outcome.result.dynamic).toEqual([{ file: "a.ts", specifier: "a" }, { file: "z.ts", specifier: "z" }])
  })
})

describe("stored row validation", () => {
  it.each([
    ["a row for different content", (digest: string) => ({ digest: `${digest}0`, specifiers: [] })],
    ["a malformed row", () => ({ digest: 7, specifiers: "none" })]
  ])("re-parses instead of trusting %s", async (_label, output) => {
    const text = `import "./dep"\n`
    await write("entry.ts", text)
    await write("dep.ts", `export const dep = 1\n`)
    const config = await loadResolverConfig({ workspaceRoot: root })
    const digest = createHash("sha256").update(text).digest("hex")
    const key = rowCacheKey(digest, config.configDigest)
    const cache = await openCache({ workspaceRoot: root })
    try {
      await cache.put(key, {
        key,
        target: rowCacheTarget,
        label: "entry.ts",
        exitOk: true,
        output: output(digest),
        storedAt: new Date(0).toISOString()
      })
      const outcome = await computeClosure({ config, entries: ["entry.ts"], cache })
      expect(outcome.stats).toEqual({ parsed: 2, cached: 0 })
      expect(outcome.result.files.map((entry) => entry.path)).toEqual(["dep.ts", "entry.ts"])
      expect((await cache.get(key))?.output).toEqual({
        digest,
        specifiers: [{ specifier: "./dep", dynamic: false }]
      })
    } finally {
      await cache.close()
    }
  })
})

describe("resolver layer failures", () => {
  it("passes a typed import-closure failure from the row store through unchanged", async () => {
    await write("src/entry.ts", `export const entry = 1\n`)
    const refusal = new Compose.ImportClosureError({ message: "row store refused" })
    const cache: CacheStore = {
      get: () => Promise.reject(refusal),
      put: () => Promise.resolve(),
      close: () => Promise.resolve()
    }
    const failure = failureOf(
      await run(Compose.ImportClosure({ entries: glob("src/entry.ts") }), { workspaceRoot: root, cache })
    )
    expect(failure).toMatchObject({ _tag: "smithers-build/ImportClosureError", message: "row store refused" })
  })

  it("reports a closure operand that cannot be computed as a files-test failure", async () => {
    await write("src/a.ts", `export const a = 1\n`)
    const target = Compose.Test({
      expect: Compose.Files.difference(
        Compose.ImportClosure({ entries: file("src/absent.ts") }),
        Compose.ImportClosure({ entries: file("src/a.ts") })
      ),
      toBe: "empty"
    })
    const failure = failureOf(await run(target, { workspaceRoot: root })) as Compose.FilesTestError
    expect(failure._tag).toBe("smithers-build/FilesTestError")
    expect(failure.message).toBe("declared entry file does not exist: src/absent.ts")
    expect(failure.leftover).toEqual([])
    expect(failure.unresolved).toEqual([])
    expect(failure.dynamic).toEqual([])
  })
})
