import { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import type { Session } from "@smthrs/sandbox/Sandbox"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, SchemaGetter, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { ScorerError } from "../src/ScorerError.ts"
import * as Scorers from "../src/Scorers.ts"
import * as ScoreStore from "../src/ScoreStore.ts"
import * as Scoring from "../src/Scoring.ts"

const input = (output: unknown, groundTruth?: unknown) => ({ input: null, output, groundTruth })
const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 keep
-old
+new
+extra
 keep
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ /dev/null
@@ -1 +0,0 @@
-removed
diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10 +10 @@
-old-again
+new-again
`
describe("built-in scorers", () => {
  it("normalizes exact equality without changing words or case", async () => {
    const scorer = Scorers.exact()
    expect(await Effect.runPromise(scorer.score(input("  A\tB\n", "A B")))).toMatchObject({ score: 1 })
    expect(await Effect.runPromise(scorer.score(input(" ", "")))).toMatchObject({ score: 1 })
    expect(await Effect.runPromise(scorer.score(input("AB", "A B")))).toMatchObject({ score: 0 })
    expect(await Effect.runPromise(scorer.score(input("a b", "A B")))).toMatchObject({ score: 0 })
    expect(await Effect.runPromise(Effect.flip(scorer.score(input(42, "42")))))
      .toMatchObject({ code: "inconclusive" })
    expect(await Effect.runPromise(Scorers.contains().score(input("prefix value suffix", "value")))).toEqual({
      score: 1
    })
    expect(await Effect.runPromise(Scorers.contains().score(input("VALUE", "value")))).toEqual({ score: 0 })
  })
  it("counts only hunk changes, deduplicates paths and includes deletions at cap boundaries", async () => {
    expect(await Effect.runPromise(Scorers.diffSize({ max: 6 }).score(input(diff)))).toMatchObject({
      score: 1,
      meta: { added: 3, removed: 3, files: 2, count: 6, max: 6 },
      reason: "3 added, 3 removed, 2 files; diffSize 6/6"
    })
    expect(await Effect.runPromise(Scorers.diffSize({ max: 5 }).score(input(diff)))).toMatchObject({ score: 0 })
    expect(await Effect.runPromise(Scorers.touchedFiles({ max: 2 }).score(input(diff)))).toMatchObject({
      score: 1,
      meta: { count: 2 }
    })
    expect(await Effect.runPromise(Scorers.touchedFiles({ max: 1 }).score(input(diff)))).toMatchObject({ score: 0 })
    expect(await Effect.runPromise(Scorers.diffSize({ max: 0 }).score(input("")))).toMatchObject({
      score: 1,
      meta: { count: 0 }
    })
  })
  it("does not confuse header-looking changed lines with file paths", async () => {
    const header = "--- a/name\n+++ b/name\n@@ -1 +1 @@\n--- old text\n+++ new text\n\\ No newline at end of file\n"
    expect(await Effect.runPromise(Scorers.diffSize({ max: 2 }).score(input(header)))).toMatchObject({
      meta: { added: 1, removed: 1, files: 1 }
    })
    const noNewline =
      "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file"
    expect(await Effect.runPromise(Scorers.diffSize({ max: 2 }).score(input(noNewline))))
      .toMatchObject({ score: 1, meta: { added: 1, removed: 1, files: 1 } })
    const quoted = "--- \"a/\\303\\251 file\"\n+++ \"b/\\303\\251 file\"\n@@ -0,0 +1 @@\n+new\n"
    expect(await Effect.runPromise(Scorers.touchedFiles({ max: 1 }).score(input(quoted)))).toMatchObject({ score: 1 })
  })
  it("refuses malformed/truncated/non-text diffs and invalid budgets", async () => {
    for (const value of ["not a diff", "@@ -1 +1 @@\n-x\n+y", "--- a/a\n+++ b/a\n@@ -2,2 +2 @@\n-x\n+y\n", 4]) {
      expect(await Effect.runPromise(Effect.flip(Scorers.diffSize({ max: 1 }).score(input(value)))))
        .toMatchObject({ code: "inconclusive" })
    }
    for (const max of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => Scorers.diffSize({ max })).toThrow()
    }
    expect(Scorers.diffSize({ max: 1 }).scorerKey).not.toBe(Scorers.diffSize({ max: 2 }).scorerKey)
  })
  it("admits additions, empty hunks, timestamp headers and quoted paths without dropping changes", async () => {
    const fixtures = [
      ["--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+added\n", 1],
      ["--- a/file\t2026-09-30\n+++ b/file\t2026-09-30\n@@ -1,0 +1,0 @@\n", 0],
      ...["\\a", "\\b", "\\t", "\\n", "\\v", "\\f", "\\r", "\\\"", "\\\\"].map((escaped) =>
        [`--- "a/${escaped}name"\n+++ "b/${escaped}name"\n@@ -1 +1 @@\n-old\n+new\n`, 2] as const
      )
    ] as const
    for (const [output, count] of fixtures) {
      expect(await Effect.runPromise(Scorers.diffSize({ max: count }).score(input(output))))
        .toMatchObject({ score: 1, meta: { count, files: 1 } })
    }
    const unicode = ["😀", "🚀"].map((name) => `--- "a/${name} name"\n+++ "b/${name} name"\n@@ -1 +1 @@\n-old\n+new\n`)
      .join("")
    expect(await Effect.runPromise(Scorers.touchedFiles({ max: 2 }).score(input(unicode))))
      .toMatchObject({ score: 1, meta: { files: 2 } })
  })
  it("counts metadata-only files from their git headers", async () => {
    const renamed = "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n"
    const mode = "diff --git a/mode b/mode\nold mode 100644\nnew mode 100755\n"
    const copy = "diff --git a/old b/copy\nsimilarity index 100%\ncopy from old\ncopy to copy\n"
    const empty = "diff --git a/my file.py b/my file.py\nnew file mode 100644\nindex 0000000..e69de29\n"
    const deleted =
      "diff --git \"a/\\360\\237\\230\\200\" \"b/\\360\\237\\230\\200\"\ndeleted file mode 100644\nindex e69de29..0000000\n"
    for (
      const [output, files, lines] of [
        [renamed, 1, 0],
        [mode, 1, 0],
        [copy, 1, 0],
        [empty, 1, 0],
        [deleted, 1, 0],
        [renamed + diff, 3, 6],
        [diff + mode, 3, 6],
        [empty + mode + diff, 4, 6]
      ] as const
    ) {
      expect(await Effect.runPromise(Scorers.touchedFiles({ max: 0 }).score(input(output))))
        .toMatchObject({ score: 0, meta: { files, count: files } })
      expect(await Effect.runPromise(Scorers.diffSize({ max: 0 }).score(input(output))))
        .toMatchObject({ score: lines === 0 ? 1 : 0, meta: { files, count: lines } })
    }
    const metadata = "diff --git a/name b/name\nold mode 100644\nnew mode 100755\nindex abc..def 100755\n"
    const text = "--- a/name\n+++ b/name\n@@ -1 +1 @@\n-old\n+new\n"
    expect(await Effect.runPromise(Scorers.touchedFiles({ max: 0 }).score(input(metadata + text))))
      .toMatchObject({ score: 0, meta: { files: 1 } })
  })
  it("keeps headers that name no file inconclusive instead of passing a zero-file budget", async () => {
    const mode = "\nold mode 100644\nnew mode 100755\n"
    // Equal halves that still name no single path: an unprefixed side, or two different paths.
    const unnamed = ["diff --git a/x b/y z", "diff --git x/a b/a", "diff --git a/a x/a", "diff --git a/a b/b"]
    for (
      const output of [
        "old mode 100644\n",
        "diff --git a/a b/a\n",
        ...unnamed.map((header) => header + mode),
        "diff --git a/a b/a\n" + diff
      ]
    ) {
      for (const scorer of [Scorers.touchedFiles({ max: 0 }), Scorers.diffSize({ max: 0 })]) {
        const failure = await Effect.runPromise(Effect.flip(scorer.score(input(output))))
        expect(failure.code).toBe("inconclusive")
      }
    }
  })
  it("refuses malformed paths, unsupported binary output and impossible hunk counts", async () => {
    const fixtures = [
      "--- a/a\n+++ b/a\n@@ wrong @@\n",
      "--- a/a\n+++ b/a\n@@ -2,2 +1 @@\n-old\n+new",
      "--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n-old\n+new",
      "--- a/a\n+++ b/a\n@@ -1,9007199254740992 +1 @@\n",
      "--- /dev/null\n+++ /dev/null\n",
      "+++ \"b/\\x\"\n",
      "+++ \"b/unclosed\n",
      "+++ \"b/\\377\"\n",
      "Binary files a/a and b/a differ\n",
      "--- a/a\n+++ b/a\n@@ -1 +0,0 @@\n context\n",
      "--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n-removed\n",
      "--- a/a\n+++ b/a\n@@ -1 +0,0 @@\n+added\n"
    ]
    for (const output of fixtures) {
      for (const scorer of [Scorers.diffSize({ max: 10 }), Scorers.touchedFiles({ max: 10 })]) {
        expect(await Effect.runPromise(Effect.flip(scorer.score(input(output)))))
          .toMatchObject({ code: "inconclusive" })
      }
    }
  })
})

describe("latency", () => {
  it("passes up to an inclusive maximum when there is no earlier warning threshold", async () => {
    const scorer = Scorers.latency({ maxMs: 100 })
    expect(await Effect.runPromise(scorer.score({ ...input(null), context: 0 }))).toEqual({
      score: 1,
      reason: "Latency 0 ms is within the 100 ms threshold",
      meta: { latencyMs: 0, maxMs: 100 }
    })
    expect(await Effect.runPromise(scorer.score({ ...input(null), context: { latencyMs: 100 } }))).toEqual({
      score: 1,
      reason: "Latency 100 ms is within the 100 ms threshold",
      meta: { latencyMs: 100, maxMs: 100 }
    })
    expect(await Effect.runPromise(scorer.score({ ...input(null), context: 100.5 }))).toEqual({
      score: 0,
      reason: "Latency 100.5 ms exceeds the 100 ms maximum",
      meta: { latencyMs: 100.5, maxMs: 100 }
    })
    expect(Scorers.latency({ maxMs: 100, warnMs: 100 }).scorerKey).toBe(scorer.scorerKey)
    expect(Scorers.latency({ maxMs: 101 }).scorerKey).not.toBe(scorer.scorerKey)
  })

  it("interpolates from the warning threshold to the maximum", async () => {
    const scorer = Scorers.latency({ maxMs: 200, warnMs: 100 })
    const score = (latencyMs: number) => Effect.runPromise(scorer.score({ ...input(null), context: { latencyMs } }))

    for (const [latencyMs, expected] of [[50, 1], [100, 1], [125, 0.75], [200, 0], [201, 0]] as const) {
      expect(await score(latencyMs)).toMatchObject({
        score: expected,
        meta: { latencyMs, maxMs: 200 }
      })
    }
    expect((await score(125)).reason).toContain("above the 100 ms warning threshold")
    expect(Scorers.latency({ warnMs: 100, maxMs: 200 }).scorerKey).toBe(scorer.scorerKey)
    expect(Scorers.latency({ maxMs: 200, warnMs: 101 }).scorerKey).not.toBe(scorer.scorerKey)
  })

  it("accepts a zero warning threshold and fractional maximum", async () => {
    const scorer = Scorers.latency({ maxMs: 0.5, warnMs: 0 })
    expect(await Effect.runPromise(scorer.score({ ...input(null), context: 0.25 }))).toMatchObject({ score: 0.5 })
  })

  it("rejects invalid limits at declaration", () => {
    for (const maxMs of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => Scorers.latency({ maxMs })).toThrow(ScorerError)
      expect(() => Scorers.latency({ maxMs })).toThrow(expect.objectContaining({
        code: "invalid_declaration",
        message: expect.stringContaining("maxMs")
      }))
    }
    for (const warnMs of [-1, 101, NaN, Infinity, -Infinity]) {
      expect(() => Scorers.latency({ maxMs: 100, warnMs })).toThrow(expect.objectContaining({
        code: "invalid_declaration",
        message: expect.stringContaining("warnMs")
      }))
    }
  })

  it("keeps missing, malformed and non-finite context data inconclusive", async () => {
    const scorer = Scorers.latency({ maxMs: 100 })
    const otherFields = { input: { latencyMs: 25 }, output: 25, latencyMs: 25 }
    const contexts = [undefined, null, {}, { latencyMs: "20" }, { latencyMs: NaN }, Infinity, -Infinity, -1, "20"]
    for (const context of contexts) {
      const failure = await Effect.runPromise(Effect.flip(scorer.score({ ...otherFields, context })))
      expect(failure).toBeInstanceOf(ScorerError)
      expect(failure.code).toBe("inconclusive")
    }
  })
})

describe("schemaAdherence", () => {
  it("scores nested valid output and explains a schema mismatch without echoing the value", async () => {
    const scorer = Scorers.schemaAdherence(Schema.Struct({ result: Schema.Struct({ count: Schema.Number }) }))
    expect(await Effect.runPromise(scorer.score(input({ result: { count: 1 } })))).toEqual({
      score: 1,
      reason: "Output matches schema"
    })
    const bad = await Effect.runPromise(scorer.score(input({ result: { count: "private value" } })))
    expect(bad).toEqual({
      score: 0,
      reason: "Output does not match schema: Expected number at [\"result\"][\"count\"]"
    })
    expect(await Effect.runPromise(scorer.score(input({ result: {} })))).toMatchObject({
      score: 0,
      reason: expect.stringContaining("Missing key")
    })
  })

  it("awaits a decoder and checks the decoded value against its refinements", async () => {
    const schema = Schema.String.pipe(
      Schema.decodeTo(Schema.Finite, {
        decode: SchemaGetter.transformEffect((value) => Effect.as(Effect.yieldNow, Number(value))),
        encode: SchemaGetter.transform(String)
      })
    )
    const scorer = Scorers.schemaAdherence(schema)
    expect(await Effect.runPromise(scorer.score(input("42")))).toMatchObject({ score: 1 })
    expect(await Effect.runPromise(scorer.score(input(42)))).toMatchObject({ score: 0 })
    expect(await Effect.runPromise(scorer.score(input("invalid number")))).toMatchObject({
      score: 0,
      reason: expect.stringContaining("finite")
    })
  })

  it("bounds a long issue reason on a UTF-8 boundary", async () => {
    const field = "🎯".repeat(100)
    const scorer = Scorers.schemaAdherence(Schema.Struct({ [field]: Schema.String }))
    const result = await Effect.runPromise(scorer.score(input({})))
    expect(result.score).toBe(0)
    expect(result.reason).toMatch(/^Output does not match schema: Missing key/)
    expect(result.reason).not.toContain("�")
    expect(new TextEncoder().encode(result.reason).length).toBeLessThanOrEqual(256)
    expect(result.reason).not.toContain(field)
  })

  it("keys the schema and the caller's identity options", () => {
    const schema = Schema.Struct({ count: Schema.Number })
    const scorer = Scorers.schemaAdherence(schema)
    expect(scorer.name).toBe("schemaAdherence")
    expect(scorer.scorerKey).toBe(Scorers.schemaAdherence(Schema.Struct({ count: Schema.Number })).scorerKey)
    expect(scorer.scorerKey).not.toBe(Scorers.schemaAdherence(Schema.Struct({ count: Schema.String })).scorerKey)
    expect(Scorers.schemaAdherence(Schema.NumberFromString).scorerKey).not.toBe(
      Scorers.schemaAdherence(Schema.NumberFromString.check(Schema.isFinite())).scorerKey
    )
    const options = { id: "example/count", name: "count", version: "2" }
    const named = Scorers.schemaAdherence(schema, options)
    expect(named.name).toBe("count")
    expect(named.scorerKey).toBe(Scorers.schemaAdherence(Schema.Struct({ count: Schema.Number }), options).scorerKey)
    for (const change of [{ id: "example/other" }, { name: "other" }, { version: "3" }]) {
      expect(named.scorerKey).not.toBe(Scorers.schemaAdherence(schema, { ...options, ...change }).scorerKey)
    }
    expect(Scorers.schemaAdherence(schema, { name: "schemaAdherence" }).scorerKey).not.toBe(scorer.scorerKey)
    expect(Scorers.schemaAdherence(schema, { id: "smithers/scorers/schema-adherence" }).scorerKey).not.toBe(
      scorer.scorerKey
    )
  })

  it("scores custom filters and non-JSON schema types", async () => {
    const custom = () =>
      Schema.String.check(Schema.makeFilter((value) => value.startsWith("ok"), { expected: "an ok-prefixed string" }))
    const filtered = Scorers.schemaAdherence(custom())
    expect(filtered.scorerKey).toBe(Scorers.schemaAdherence(custom()).scorerKey)
    expect(filtered.scorerKey).not.toBe(Scorers.schemaAdherence(Schema.String).scorerKey)
    expect(await Effect.runPromise(filtered.score(input("ok-value")))).toMatchObject({ score: 1 })
    expect(await Effect.runPromise(filtered.score(input("bad")))).toMatchObject({
      score: 0,
      reason: "Output does not match schema: Expected an ok-prefixed string"
    })

    const key = Symbol("measure")
    const schema = Schema.Struct({ [key]: Schema.Literal(1n) })
    const scorer = Scorers.schemaAdherence(schema)
    expect(scorer.scorerKey).toBe(Scorers.schemaAdherence(Schema.Struct({ [key]: Schema.Literal(1n) })).scorerKey)
    expect(scorer.scorerKey).not.toBe(Scorers.schemaAdherence(Schema.Struct({ [key]: Schema.Literal(2n) })).scorerKey)
    expect(await Effect.runPromise(scorer.score(input({ [key]: 1n })))).toMatchObject({ score: 1 })
    expect(await Effect.runPromise(scorer.score(input({ [key]: 2n })))).toMatchObject({ score: 0 })
  })
})

describe("testsPass sandbox boundary", () => {
  it("keeps invalid exit codes and failed output transport inconclusive", async () => {
    for (const exitCode of [-1, Number.NaN, 1.5, Infinity]) {
      const sandbox = {
        spawn: () => Effect.succeed({ exitCode: Effect.succeed(exitCode), stdout: Stream.empty, stderr: Stream.empty })
      }
      expect(await Effect.runPromise(Effect.flip(Scorers.testsPass({ command: "test", sandbox }).score(input(null)))))
        .toMatchObject({ code: "inconclusive" })
    }
    const failure = new ProviderError({ code: "unavailable", message: "lost output transport" })
    for (const channel of ["stdout", "stderr"] as const) {
      const sandbox = {
        spawn: () =>
          Effect.succeed({
            exitCode: Effect.succeed(0),
            stdout: Stream.empty,
            stderr: Stream.empty,
            [channel]: Stream.fail(failure)
          })
      }
      expect(await Effect.runPromise(Effect.flip(Scorers.testsPass({ command: "test", sandbox }).score(input(null)))))
        .toMatchObject({ code: "inconclusive" })
    }
  })
  it("executes the exact declared command, drains both streams and distinguishes exit zero from exit one", async () => {
    const calls: string[] = []
    for (const exitCode of [0, 1]) {
      const drained: string[] = []
      const sandbox: Pick<Session, "spawn"> = {
        spawn: (command, options) => {
          calls.push(command)
          expect(options).toEqual({})
          return Effect.succeed({
            exitCode: Effect.succeed(exitCode),
            stdout: Stream.fromEffect(Effect.sync(() => {
              drained.push("stdout")
              return new Uint8Array()
            })),
            stderr: Stream.fromEffect(Effect.sync(() => {
              drained.push("stderr")
              return new Uint8Array()
            }))
          })
        }
      }
      expect(await Effect.runPromise(Scorers.testsPass({ command: "pnpm test", sandbox }).score(input(null))))
        .toEqual({ score: exitCode === 0 ? 1 : 0, reason: `Command exited ${exitCode}`, meta: { exitCode } })
      expect(drained.sort()).toEqual(["stderr", "stdout"])
    }
    expect(calls).toEqual(["pnpm test", "pnpm test"])
  })
  it("retains launch failures as inconclusive observations through the public runner", async () => {
    const scorer = Scorers.testsPass({
      command: "test",
      sandbox: {
        spawn: () => Effect.fail(new ProviderError({ code: "unavailable", message: "launch unavailable" }))
      }
    })
    const observations = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* Scoring.runBatch([{
          identity: "launch-failure",
          observation: { targetStepKey: "run", scorerKey: scorer.scorerKey },
          score: scorer.score(input(null)),
          at: 1
        }])
      }).pipe(Effect.provide(ScoreStore.layerNoop))
    )
    expect(observations).toMatchObject([{
      kind: "inconclusive",
      code: "inconclusive",
      reason: expect.stringContaining("could not complete")
    }])
  })
  it("releases a hung command on timeout and fiber cancellation", async () => {
    for (const cancel of [false, true]) {
      let released = false
      const started = await Effect.runPromise(Deferred.make<void>())
      const scorer = Scorers.testsPass({
        command: "hang",
        timeoutMs: cancel ? 60_000 : 20,
        sandbox: {
          spawn: () =>
            Effect.gen(function*() {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  released = true
                })
              )
              yield* Deferred.succeed(started, undefined)
              return { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.never }
            })
        }
      })
      const exit = await Effect.runPromise(Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(scorer.score(input(null)))
        yield* Deferred.await(started)
        if (cancel) yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterrupts(exit.cause)).toBe(cancel)
        expect(Cause.hasDies(exit.cause)).toBe(false)
        if (!cancel) expect(Cause.squash(exit.cause)).toMatchObject({ code: "inconclusive" })
      }
      expect(released).toBe(true)
    }
  })
  it("refuses invalid commands/deadlines and keys command changes", () => {
    const sandbox = { spawn: () => Effect.never }
    for (const command of ["", " "]) expect(() => Scorers.testsPass({ command, sandbox })).toThrow()
    for (const timeoutMs of [0, -1, 1.5, Infinity]) {
      expect(() => Scorers.testsPass({ command: "test", sandbox, timeoutMs })).toThrow()
    }
    expect(Scorers.testsPass({ command: "a", sandbox }).scorerKey).not.toBe(
      Scorers.testsPass({ command: "b", sandbox }).scorerKey
    )
  })
})
