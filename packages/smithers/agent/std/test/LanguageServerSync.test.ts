/**
 * The mutation flows keep a bound `LanguageServer` in step: what they write is
 * synced, what they delete is closed, and the errors the server reports for an
 * edit come back on its output. A server is optional, and one that fails never
 * fails the write. `@smthrs/platform-node`'s `NodeLanguageServer` tests cover
 * the client a Node host binds.
 */
import { Cause, Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import * as Diagnostics from "../src/internal/Diagnostics.vibe"
import * as LanguageServer from "../src/LanguageServer.vibe"
import * as StdError from "../src/StdError.vibe"
import * as Write from "../src/Write.ts"
import { layer } from "./TestLayers.ts"

/** One error per line of `text` that contains `ERROR`. */
const errorsIn = (text: string) =>
  text.split("\n").flatMap((line, index) =>
    line.includes("ERROR")
      ? [{
        range: { start: { line: index, character: line.indexOf("ERROR") }, end: { line: index, character: 0 } },
        severity: 1,
        message: `bad ${index}`
      }]
      : []
  )

const failureOf = <A>(exit: Exit.Exit<A, StdError.StdError>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined

const recording = (
  diagnostics: LanguageServer.LanguageServer["diagnostics"],
  options?: { readonly syncFails?: boolean }
) => {
  const synced: Array<readonly [string, string]> = []
  const closed: Array<string> = []
  let asked = 0
  let refreshed = 0
  const server = LanguageServer.make({
    ...LanguageServer.makeNoop(),
    sync: (path, text) =>
      options?.syncFails === true
        ? Effect.fail(new StdError.StdError({ code: "request_failed", message: "gone" }))
        : Effect.sync(() => void synced.push([path, text])),
    close: (path) => Effect.sync(() => void closed.push(path)),
    refresh: Effect.sync(() => void refreshed++),
    diagnostics: (path) => Effect.suspend(() => (asked++, diagnostics(path)))
  })
  return {
    synced,
    closed,
    asked: () => asked,
    refreshed: () => refreshed,
    layer: Layer.succeed(LanguageServer.LanguageServer, server)
  }
}

describe("mutation flows keep the language server in step", () => {
  it("attaches the errors the bound server reports to Edit's output", async () => {
    const recorder = recording((path) =>
      Effect.succeed({ kind: "full", items: errorsIn(recorder.synced.findLast(([synced]) => synced === path)![1]) })
    )
    const edit = (oldString: string, newString: string) =>
      Edit.run({ path: "/a.ts", oldString, newString }).pipe(
        Effect.provide(recorder.layer),
        Effect.provide(layer({ files: { "/a.ts": "const a = 1\nconst b = 2\n" } }))
      )
    const broken = await Effect.runPromise(edit("const b = 2", "ERROR b"))
    const fixed = await Effect.runPromise(edit("const b = 2", "const b = 3"))
    expect(broken.errors).toEqual([{ line: 2, character: 1, message: "bad 1" }])
    expect(fixed.errors).toEqual([])
    expect(recorder.synced).toEqual([["/a.ts", "const a = 1\nERROR b\n"], ["/a.ts", "const a = 1\nconst b = 3\n"]])
    expect(recorder.asked()).toBe(2)
  })

  it("leaves errors off Edit's output when no server is bound or it fails", async () => {
    const files = { "/a.ts": "x" }
    const unbound = await Effect.runPromise(
      Edit.run({ path: "/a.ts", oldString: "x", newString: "y" }).pipe(Effect.provide(layer({ files })))
    )
    const failing = recording(() => Effect.fail(new StdError.StdError({ code: "timeout", message: "slow" })))
    const failed = await Effect.runPromise(
      Edit.run({ path: "/a.ts", oldString: "x", newString: "y" }).pipe(
        Effect.provide(failing.layer),
        Effect.provide(layer({ files }))
      )
    )
    const noop = await Effect.runPromise(
      Edit.run({ path: "/a.ts", oldString: "x", newString: "y" }).pipe(
        Effect.provide(LanguageServer.layerNoop),
        Effect.provide(layer({ files }))
      )
    )
    expect("errors" in unbound).toBe(false)
    expect("errors" in failed).toBe(false)
    expect(failing.synced).toEqual([["/a.ts", "y"]])
    expect("errors" in noop).toBe(false)
    expect(failing.asked()).toBe(1)
  })

  it("deletes through ApplyPatch with no server bound", async () => {
    const output = await Effect.runPromise(
      ApplyPatch.run({ input: "*** Begin Patch\n*** Delete File: /gone.ts\n*** End Patch" }).pipe(
        Effect.provide(layer({ files: { "/gone.ts": "x" } }))
      )
    )
    expect(output.deleted).toEqual(["/gone.ts"])
  })

  it("does not ask for diagnostics when the sync failed", async () => {
    const recorder = recording(() => Effect.succeed({ kind: "full", items: [] }), { syncFails: true })
    const output = await Effect.runPromise(
      Edit.run({ path: "/a.ts", oldString: "x", newString: "y" }).pipe(
        Effect.provide(recorder.layer),
        Effect.provide(layer({ files: { "/a.ts": "x" } }))
      )
    )
    expect(output).toMatchObject({ path: "/a.ts", replacements: 1 })
    expect("errors" in output).toBe(false)
    expect(recorder.asked()).toBe(0)
  })

  it("syncs what Write and ApplyPatch write", async () => {
    const recorder = recording(() => Effect.succeed({ kind: "full", items: [] }))
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Write.run({ path: "/w.ts", content: "written" })
        yield* ApplyPatch.run({
          input: [
            "*** Begin Patch",
            "*** Add File: /added.ts",
            "+new",
            "*** Update File: /old.ts",
            "*** Move to: /moved.ts",
            "@@",
            "-old",
            "+changed",
            "*** Delete File: /gone.ts",
            "*** End Patch"
          ].join("\n")
        })
      }).pipe(Effect.provide(recorder.layer), Effect.provide(layer({ files: { "/old.ts": "old\n", "/gone.ts": "x" } })))
    )
    expect(recorder.synced).toEqual([
      ["/w.ts", "written"],
      ["/added.ts", "new\n"],
      ["/moved.ts", "changed\n"]
    ])
    expect(recorder.closed).toEqual(["/old.ts", "/gone.ts"])
  })
})

describe("LanguageServer.makeNoop", () => {
  it("is unsupported without a server", async () => {
    const exit = await Effect.runPromise(Effect.exit(LanguageServer.makeNoop().refresh))
    expect(failureOf(exit)).toMatchObject({ code: "unsupported" })
  })
})

describe("Diagnostics.errors", () => {
  it("keeps error-severity items at 1-based positions and skips the rest", () => {
    const at = (line: number, character: number) => ({ start: { line, character } })
    expect(Diagnostics.errors(undefined)).toEqual([])
    expect(Diagnostics.errors([])).toEqual([])
    expect(Diagnostics.errors({ items: "no" })).toEqual([])
    expect(Diagnostics.errors({
      items: [
        { severity: 1, message: "kept", range: at(0, 4) },
        { severity: 2, message: "warning", range: at(1, 0) },
        { message: "no severity", range: at(1, 0) },
        { severity: 1, message: 3, range: at(1, 0) },
        { severity: 1, message: "no range" },
        { severity: 1, message: "bad start", range: { start: { line: "1", character: 0 } } },
        { severity: 1, message: "bad character", range: { start: { line: 1 } } },
        null
      ]
    })).toEqual([{ line: 1, character: 5, message: "kept" }])
  })

  it("caps the attached errors", () => {
    const items = Array.from({ length: 30 }, (_, line) => ({
      severity: 1,
      message: `e${line}`,
      range: { start: { line, character: 0 } }
    }))
    expect(Diagnostics.errors({ items })).toHaveLength(Diagnostics.MAX_ERRORS)
  })
})
