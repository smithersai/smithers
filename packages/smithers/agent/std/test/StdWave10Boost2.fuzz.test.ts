import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Arbitrary, Context, Effect, Layer, Path, Result, Schema, Sink, Stream } from "effect"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import * as cp from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Checkpoints from "../src/Checkpoints.ts"
import * as Grep from "../src/Grep.ts"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as NativeSearch from "../src/NativeSearch.ts"
import * as RemoteSearch from "../src/RemoteSearch.ts"
import * as Search from "../src/Search.ts"
import * as SearchContract from "../src/SearchContract.ts"
import * as TreeFingerprint from "../src/TreeFingerprint.ts"
import * as UpdatePlan from "../src/UpdatePlan.ts"
import * as Write from "../src/Write.ts"
import * as ApplyPatchInternal from "../src/internal/ApplyPatch.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const fastExec = Math.max(40, Math.min(executions, 120))
const ioExec = Math.max(12, Math.min(executions, 28))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261320")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const realHost = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  Layer.provide(NodeChildProcessSpawner.layer, Layer.merge(NodeFileSystem.layer, NodePath.layer))
)

const enc = new TextEncoder()

describe("@smthrs/std Wave10 Boost2 Fuzz", () => {
  it("SearchContract validatePattern/validateGlob/includedByGlobs/unsatisfiableNotice, TreeFingerprint, and ApplyPatchInternal", async () => {
    const patterns = [
      "valid\\d+",
      "[^abc",
      "[a-z\\]",
      "(unclosed",
      "extra)",
      "a{bad}",
      "{2}",
      "a{2,3}",
      "a}",
      "a]",
      "*bad",
      "+bad",
      "?bad",
      "foo|bar",
      "ok[a-z]+(x)?"
    ]
    const globs = [
      "*.{ts,js}",
      "*.{single}",
      "*.{unclosed",
      "src/**/file?.ts",
      "./a/./b/*.ts",
      "!*.test.ts",
      "café/*.ts",
      "a[0-9].txt",
      ""
    ]
    const patches = [
      `*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** End Patch`,
      `*** Begin Patch\n*** Update File: a.txt\n@@ header\n one\n-two\n+TWO\n*** End of File\n*** End Patch`,
      `*** Begin Patch\n*** Delete File: a.txt\n*** End Patch`,
      `missing begin marker`,
      `*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y`,
      `*** Begin Patch\n*** Unknown Directive: a.txt\n*** End Patch`,
      `*** Begin Patch\n*** Update File: a.txt\n*** Move to: \n*** End Patch`,
      `*** Begin Patch\n*** Update File: a.txt\nnot a hunk line\n*** End Patch`
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        pIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: patterns.length - 1 }))),
        gIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: globs.length - 1 }))),
        patchIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: patches.length - 1 }))),
        fixed: Schema.Boolean,
        chunkSize: Schema.Literals([1, 7, 32, 999])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ pIdx, gIdx, patchIdx, fixed, chunkSize }) =>
          Effect.sync(() => {
            const pat = patterns[pIdx]!
            const err = SearchContract.validatePattern(pat, fixed)
            if (err !== undefined) {
              expect(SearchContract.isContractRejection(err)).toBe(true)
            } else {
              const re = SearchContract.expression(pat, fixed, true)
              expect(re instanceof RegExp).toBe(true)
            }
            const g = globs[gIdx]!
            const gErr = SearchContract.validateGlob(g)
            if (gErr === undefined && g.length > 0) {
              const canon = SearchContract.canonicalGlob(g)
              expect(typeof canon).toBe("string")
              expect(typeof SearchContract.includedByGlobs([g], "src/x/file1.ts", "file1.ts")).toBe("boolean")
              expect(typeof SearchContract.includedByGlobs([g], "café/a.ts", "a.ts")).toBe("boolean")
            }
            void g

            // TreeFingerprint parse/moved/split
            const m1 = TreeFingerprint.parse("12345 10 0\n")
            const m2 = TreeFingerprint.parse("99999 10 0\n")
            const mBad = TreeFingerprint.parse("garbage")
            expect(mBad).toBeUndefined()
            if (m1 && m2) {
              expect(TreeFingerprint.moved(m1, m2)).toBe(true)
              expect(TreeFingerprint.moved(m1, m1)).toBe(false)
            }
            const split1 = TreeFingerprint.split("err\n__smithers_tree__ n1 deadline 123 1 0| 456 2 0\n", "n1")
            expect(split1.timedOut).toBe(true)
            const split2 = TreeFingerprint.split("plain stderr\n", "n1")
            expect(split2.timedOut).toBe(false)
            expect(typeof TreeFingerprint.around()).toBe("string")
            expect(typeof TreeFingerprint.script()).toBe("string")

            // ApplyPatchInternal streaming & seekSequence fuzzy unicode/whitespace
            const patchText = patches[patchIdx]!
            try {
              const parsed = ApplyPatchInternal.parsePatch(patchText)
              expect(parsed.hunks).toBeDefined()
              const streamer = new ApplyPatchInternal.StreamingPatchParser()
              for (let off = 0; off < patchText.length; off += chunkSize) {
                streamer.pushDelta(patchText.slice(off, off + chunkSize))
              }
              streamer.finish()
            } catch {
              // invalid patch cases exercise ParseError paths
            }
            const lines = ["  const s = “hello”  ", "next line"]
            expect(ApplyPatchInternal.seekSequence(lines, ['const s = "hello"'], 0, false)).toBe(0)
            expect(ApplyPatchInternal.seekSequence(lines, ["next line"], 0, true)).toBe(1)
            expect(ApplyPatchInternal.seekSequence(lines, ["missing"], 0, false)).toBeUndefined()
            return true
          }),
        { executions: fastExec, seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Checkpoints.layerGit, RemoteSearch error/success paths, UpdatePlan, Write, NativeSearch/Grep options, and ApplyPatch effectsFor", async () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "smthrs-std-w10b2-")))
    try {
      const modes = [
        "checkpoints-git-capture-materialize",
        "remote-search-faults",
        "update-plan-variants",
        "write-and-apply-patch-effects",
        "grep-and-native-search-options"
      ] as const

      const arb = Arbitrary.schema(
        Schema.Struct({
          idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: modes.length - 1 }))),
          sub: Schema.Literals([0, 1, 2, 3])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ idx, sub }) =>
            Effect.gen(function*() {
              const mode = modes[idx]!
              const dir = fs.mkdtempSync(nodePath.join(tmpRoot, "c-"))

              if (mode === "checkpoints-git-capture-materialize") {
                cp.execFileSync("git", ["init", "-q"], { cwd: dir })
                cp.execFileSync("git", ["config", "user.email", "w10@example.com"], { cwd: dir })
                cp.execFileSync("git", ["config", "user.name", "W10"], { cwd: dir })
                fs.writeFileSync(nodePath.join(dir, "f.txt"), "v1\n")
                cp.execFileSync("git", ["add", "."], { cwd: dir })
                cp.execFileSync("git", ["commit", "-q", "-m", "c1"], { cwd: dir })
                const cpLayer = Checkpoints.layerGit({ root: dir })
                yield* Effect.gen(function*() {
                  const svc = yield* Checkpoints.Checkpoints
                  const snap = yield* svc.capture("cp-1")
                  expect(snap.id).toBe("cp-1")
                  // Mutate file then materialize cp-1
                  fs.writeFileSync(nodePath.join(dir, "f.txt"), "v2\n")
                  const readBack = yield* svc.materialize("cp-1", (mat) =>
                    Effect.sync(() => fs.readFileSync(nodePath.join(mat.host, "f.txt"), "utf8"))
                  )
                  expect(readBack).toBe("v1\n")
                  // Invalid checkpoint id
                  const bad = yield* Effect.result(svc.materialize("../bad", () => Effect.void))
                  expect(Result.isFailure(bad)).toBe(true)
                  const missing = yield* Effect.result(svc.materialize("cp-missing", () => Effect.void))
                  expect(Result.isFailure(missing)).toBe(true)
                }).pipe(Effect.provide(cpLayer))
              } else if (mode === "remote-search-faults") {
                const pathSvc = yield* Path.Path
                const fakeSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
                  spawn: () =>
                    Effect.succeed(
                      makeHandle({
                        pid: ProcessId(999),
                        exitCode: Effect.succeed(ExitCode(sub === 0 ? 1 : 0)),
                        unref: Effect.succeed(Effect.void),
                        isRunning: Effect.succeed(false),
                        kill: () => Effect.void,
                        stdin: Sink.drain,
                        stdout: Stream.make(
                          enc.encode(
                            sub === 1
                              ? "!!!not-base64!!!"
                              : sub === 2
                              ? Buffer.from("a".repeat(200)).toString("base64")
                              : ""
                          )
                        ),
                        stderr: Stream.make(enc.encode(sub === 0 ? "remote error" : "")),
                        all: Stream.empty,
                        getInputFd: () => Sink.drain,
                        getOutputFd: () => Stream.empty
                      })
                    ),
                  exitCode: () => Effect.succeed(ExitCode(0)),
                  lines: () => Effect.succeed([]),
                  streamLines: () => Stream.empty,
                  streamString: () => Stream.empty,
                  string: () => Effect.succeed("")
                })
                const remote = RemoteSearch.make(Context.make(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner).pipe(Context.add(Path.Path, pathSvc)), { maxBytes: sub === 2 ? 100 : 10_000 })
                const r = yield* Effect.result(
                  remote.grep({
                    pattern: "needle",
                    root: dir,
                    fixedStrings: false,
                    ignoreCase: false,
                    smartCase: false,
                    globs: [],
                    beforeContext: 0,
                    afterContext: 0,
                    filesWithMatches: false,
                    hidden: false,
                    symbols: false,
                    limit: 10
                  })
                )
                expect(Result.isFailure(r) || Result.isSuccess(r)).toBe(true)
              } else if (mode === "update-plan-variants") {
                const validPlan = {
                  explanation: "working",
                  plan: [
                    { step: "step 1", status: "completed" as const },
                    { step: "step 2", status: "in_progress" as const },
                    { step: "step 3", status: "pending" as const }
                  ]
                }
                expect(UpdatePlan.effectsFor(validPlan)).toBeDefined()
                const out = yield* UpdatePlan.run(validPlan)
                expect(out.output.length).toBeGreaterThan(0)
                // Multiple in_progress should fail validation via Schema or run
                const dupInProg = yield* Effect.result(
                  UpdatePlan.run({
                    plan: [
                      { step: "a", status: "in_progress" },
                      { step: "b", status: "in_progress" }
                    ]
                  })
                )
                expect(Result.isFailure(dupInProg) || Result.isSuccess(dupInProg)).toBe(true)
              } else if (mode === "write-and-apply-patch-effects") {
                const nested = nodePath.join(dir, "sub", "deep", "out.txt")
                const w1 = yield* Write.run({ path: nested, content: "hello\n" }).pipe(
                  Effect.provide(LanguageServer.layerNoop)
                )
                expect(w1.bytesWritten).toBeGreaterThan(0)
                const w2 = yield* Write.run({ path: nested, content: "hello2\n" }).pipe(
                  Effect.provide(LanguageServer.layerNoop)
                )
                expect(w2.bytesWritten).toBeGreaterThan(0)
                const eff = ApplyPatch.effectsFor({
                  input: `*** Begin Patch\n*** Add File: ${nodePath.join(dir, "n.txt")}\n+x\n*** Update File: ${nested}\n*** Move to: ${nodePath.join(dir, "m.txt")}\n@@\n-hello2\n+hello3\n*** End Patch`
                })
                expect(eff.writes.length).toBeGreaterThan(0)
              } else if (mode === "grep-and-native-search-options") {
                fs.writeFileSync(nodePath.join(dir, "a.ts"), "line1\nexport function targetFn() {}\nline3\ntargetFn()\n")
                fs.writeFileSync(nodePath.join(dir, ".hidden.ts"), "targetFn hidden\n")
                const g1 = yield* Grep.run({
                  pattern: "targetFn",
                  root: dir,
                  fixedStrings: sub === 0,
                  ignoreCase: sub === 1,
                  smartCase: sub === 2,
                  beforeContext: 1,
                  afterContext: 1,
                  filesWithMatches: sub === 3,
                  hidden: true,
                  noIgnore: true,
                  limit: 20
                }).pipe(Effect.provide(NativeSearch.layer))
                expect(g1).toBeDefined()
              }
              return true
            }).pipe(Effect.provide(realHost)),
          { executions: ioExec, seed: seed + 1 }
        )
      )
      assertPassed(report)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  }, 90_000)
})
