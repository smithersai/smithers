import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Grep from "../src/Grep.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("Grep", () => {
  it("declares only the options v1 honours", () => {
    expect(Object.keys(Grep.Input.fields)).not.toContain("types")
    expect(Schema.decodeUnknownSync(Grep.Input)({ pattern: "a", noIgnore: true })).toEqual({
      pattern: "a",
      noIgnore: true
    })
    expect(Schema.decodeUnknownSync(Grep.Input)({ pattern: "a", noIgnore: false }).noIgnore).toBe(false)
  })

  it("searches regexes and literal text with 1-based line numbers", async () => {
    const files = { "/src/a.ts": "one\nfoo.bar\nthree", "/src/b.js": "fooXbar" }
    const regex = await execute(
      Effect.provide(Grep.run({ pattern: "foo.bar", root: "/src", globs: ["*.ts"] }), layer({ files }))
    )
    const literal = await execute(
      Effect.provide(Grep.run({ pattern: "foo.bar", fixedStrings: true, root: "/src" }), layer({ files }))
    )
    expect(regex.matches).toEqual([{ file: "/src/a.ts", line: 2, text: "foo.bar", before: [], after: [] }])
    expect(literal.matches).toEqual([{ file: "/src/a.ts", line: 2, text: "foo.bar", before: [], after: [] }])
    expect(regex.filesSearched).toBe(1)
  })

  it("caps previews, skips binary files, and counts searched files", async () => {
    const result = await execute(Effect.provide(
      Grep.run({ pattern: "x", root: "/src" }),
      layer({
        files: { "/src/long.txt": "x".repeat(600), "/src/binary.bin": "before\0after" }
      })
    ))
    expect(result.matches[0]?.text.length).toBeLessThanOrEqual(500)
    expect(result).toMatchObject({ filesSearched: 2, skippedBinary: 1 })
  })

  it("reports invalid regular expressions as typed failures", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Grep.run({ pattern: "[", root: "/src" })),
      layer({
        files: { "/src/a.txt": "text" }
      })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason).toBeDefined()
      if (reason === undefined) return
      expect(Cause.isFailReason(reason) && reason.error.code).toBe("invalid_pattern")
    }
  })

  it("collects evidence past the limit and discloses truncation", async () => {
    const result = await execute(Effect.provide(
      Grep.run({ pattern: "hit", root: "/src", limit: 1 }),
      layer({
        files: { "/src/a.txt": "hit\nhit" }
      })
    ))
    expect(result).toMatchObject({
      truncated: true,
      matches: [{ file: "/src/a.txt", line: 1, text: "hit", before: [], after: [] }]
    })
    expect(result.notice).toBeDefined()
  })

  it("skips repository metadata and caches unless the caller names one as the root", async () => {
    const files = {
      "/repo/source.py": "needle",
      "/repo/.git/objects/object.py": "needle",
      "/repo/.jj/store/object.py": "needle",
      "/repo/.flows/engine.py": "needle",
      "/repo/node_modules/package.py": "needle",
      "/repo/.venv/site.py": "needle"
    }
    const broad = await execute(
      Effect.provide(Grep.run({ pattern: "needle", root: "/repo", globs: ["*.py"] }), layer({ files }))
    )
    const explicit = await execute(
      Effect.provide(Grep.run({ pattern: "needle", root: "/repo/.git", globs: ["*.py"] }), layer({ files }))
    )

    expect(broad).toMatchObject({
      matches: [{ file: "/repo/source.py", line: 1, text: "needle", before: [], after: [] }],
      filesSearched: 1
    })
    expect(explicit).toMatchObject({
      matches: [{ file: "/repo/.git/objects/object.py", line: 1, text: "needle", before: [], after: [] }],
      filesSearched: 1
    })
  })

  it("spends the limit on matches and keeps each hit's own context", async () => {
    // The row budget used to be spendable on context, so a hit could be dropped
    // to make room for the lines around another one.
    const result = await execute(Effect.provide(
      Grep.run({ pattern: "needle", root: "/src", context: 1, limit: 1 }),
      layer({ files: { "/src/a.txt": "before\nneedle one\nbetween\nneedle two\nafter" } })
    ))
    expect(result.matches).toEqual([{
      file: "/src/a.txt",
      line: 2,
      text: "needle one",
      before: [{ line: 1, text: "before" }],
      after: [{ line: 3, text: "between" }]
    }])
    expect(result.truncated).toBe(true)
    expect(result.notice).toBe("Showing 1 of 2 matches; output was truncated.")
  })

  it("gives every context line to exactly one hit", async () => {
    const result = await execute(Effect.provide(
      Grep.run({ pattern: "needle", root: "/src", context: 2 }),
      layer({ files: { "/src/a.txt": "one\nneedle\nthree\nfour\nneedle\nsix" } })
    ))
    const lines = result.matches.flatMap((match) => [...match.before, ...match.after].map((line) => line.line))
    expect(lines).toEqual([1, 3, 4, 6])
    expect(result.matches.map((match) => match.line)).toEqual([2, 5])
  })

  it("reports the definition a hit sits in", async () => {
    const result = await execute(Effect.provide(
      Grep.run({ pattern: "return value", root: "/src" }),
      layer({
        files: {
          "/src/mod.py":
            "class Widget:\n    def widen(self, value):\n        return value\n\n\ndef other():\n    pass\n"
        }
      })
    ))
    expect(result.matches[0]?.symbol).toEqual({ kind: "def", name: "widen", startLine: 2, endLine: 3 })
  })

  it("omits the enclosing definition when the caller turns it off", async () => {
    const result = await execute(Effect.provide(
      Grep.run({ pattern: "return value", root: "/src", symbols: false }),
      layer({ files: { "/src/mod.py": "def widen(value):\n    return value\n" } })
    ))
    expect(result.matches).toHaveLength(1)
    expect(Object.hasOwn(result.matches[0] ?? {}, "symbol")).toBe(false)
  })

  it("retries a metacharacter pattern as a literal and says that it did", async () => {
    const files = { "/src/a.py": "value = compute(a, b)\n" }
    const retried = await execute(
      Effect.provide(Grep.run({ pattern: "compute(a, b)", root: "/src" }), layer({ files }))
    )
    const genuinelyAbsent = await execute(
      Effect.provide(Grep.run({ pattern: "absent(x)", root: "/src" }), layer({ files }))
    )
    expect(retried.matches.map((match) => match.line)).toEqual([1])
    expect(retried.retriedAsLiteral).toBe(true)
    expect(retried.notice).toContain("fixedStrings: true")
    expect(genuinelyAbsent.matches).toEqual([])
    expect(Object.hasOwn(genuinelyAbsent, "retriedAsLiteral")).toBe(false)
  })

  it("declares sealed hermetic effects and narrows to the root subtree", () => {
    expect(Grep.effects).toMatchObject({ tier: "sealed", mode: "hermetic" })
    expect(Grep.effectsFor({ root: "/src" }).reads).toEqual(["/src/**"])
  })
})
