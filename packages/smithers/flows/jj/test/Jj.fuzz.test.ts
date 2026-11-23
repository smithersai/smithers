import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import * as nodeFs from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as BrowserJj from "../src/browser/BrowserJj.ts"
import type { SyncFsLike } from "../src/browser/WasiFs.ts"
import { Errno, make as makeWasi, WasiExitError } from "../src/browser/WasiPreview1.ts"
import * as BunJj from "../src/bun/BunJj.ts"
import {
  causeMessageLimit,
  isGitLockContention,
  isJjError,
  Jj,
  JjErrorCause,
  JjErrorCode,
  jjError,
  jjErrorCause,
  layerNoop,
  make as makeJj,
  makeNoop,
  Repository,
  RepositoryMutation
} from "../src/index.ts"
import { quoteGitPatchPaths } from "../src/internal/gitPatchPaths.ts"
import { JjInternalFault } from "../src/internal/JjInternalFault.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import * as ResolveJjBinary from "../src/node/resolveJjBinary.ts"
import { fakeFlowsJjWasm } from "./FakeFlowsJjWasm.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const jjAvailable = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

describe("@smthrs/jj fuzz invariants", () => {
  let tempRoot = ""

  beforeAll(() => {
    tempRoot = nodeFs.mkdtempSync(join(tmpdir(), "smthrs-jj-fuzz-"))
  })

  afterAll(() => {
    if (tempRoot !== "") {
      nodeFs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("JjErrorCause projection bounds lengths, survives cyclic/throwing causes, and decodes cleanly", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "error",
          "string",
          "number",
          "null",
          "undefined",
          "object",
          "cyclic",
          "throwing_getter",
          "long_fields"
        ]),
        name: Schema.String.pipe(Schema.check(Schema.isMaxLength(120))),
        code: Schema.String.pipe(Schema.check(Schema.isMaxLength(120))),
        message: Schema.String.pipe(Schema.check(Schema.isMaxLength(200))),
        repeat: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 15 }))),
        errorCode: JjErrorCode,
        method: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            let rawCause: unknown
            switch (input.kind) {
              case "error": {
                const e = new Error(input.message)
                e.name = input.name || "Error"
                ;(e as Error & { code?: string }).code = input.code
                rawCause = e
                break
              }
              case "string":
                rawCause = input.message.repeat(input.repeat)
                break
              case "number":
                rawCause = input.repeat
                break
              case "null":
                rawCause = null
                break
              case "undefined":
                rawCause = undefined
                break
              case "object":
                rawCause = { name: input.name, code: input.code, message: input.message }
                break
              case "cyclic": {
                const obj: Record<string, unknown> = { message: input.message }
                obj.self = obj
                rawCause = obj
                break
              }
              case "throwing_getter": {
                const obj = {}
                Object.defineProperty(obj, "message", {
                  get() {
                    throw new Error("boom")
                  }
                })
                Object.defineProperty(obj, "name", {
                  get() {
                    throw new Error("boom")
                  }
                })
                Object.defineProperty(obj, "code", {
                  get() {
                    throw new Error("boom")
                  }
                })
                rawCause = obj
                break
              }
              case "long_fields":
                rawCause = {
                  name: ("N" + input.name).repeat(20),
                  code: ("C" + input.code).repeat(20),
                  message: ("M" + input.message).repeat(20)
                }
                break
            }

            const projected = jjErrorCause(rawCause)
            if (projected.message.length > causeMessageLimit) return false
            if (projected.name !== undefined && projected.name.length > causeMessageLimit) return false
            if (projected.code !== undefined && projected.code.length > causeMessageLimit) return false

            const decoded = Schema.decodeUnknownSync(JjErrorCause)(JSON.parse(JSON.stringify(projected)))
            if (decoded.message !== projected.message) return false

            const err = jjError({
              code: input.errorCode,
              method: input.method,
              description: input.message || "desc"
            })
            if (!isJjError(err)) return false
            if (isJjError(new Error("plain"))) return false
            if (err.code !== input.errorCode || err.method !== input.method) return false
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("Jj makeNoop / layerNoop / make and isGitLockContention hold strict contracts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        methodIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 8 }))),
        lockKind: Schema.Literals(["index_lock", "ref_lock", "private_index", "conflict", "arbitrary"]),
        attempts: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 99 }))),
        refName: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
        noise: Schema.String.pipe(Schema.check(Schema.isMaxLength(64)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const noop = makeNoop({})
            const calls: ReadonlyArray<Effect.Effect<unknown, unknown>> = [
              noop.snapshot("msg"),
              noop.restore("abc"),
              noop.diff("a", "b"),
              noop.workspaceAdd("w", "/tmp/x"),
              noop.workspaceForget("w"),
              noop.status(),
              noop.root!("/tmp"),
              noop.revert!("abc"),
              noop.opRestore!("op1")
            ]
            const exit = yield* Effect.exit(calls[input.methodIdx]!)
            if (!Exit.isFailure(exit)) return false
            const err = Cause.squash(exit.cause)
            if (!isJjError(err) || err.code !== "not_installed") return false

            const overridden = yield* Effect.provide(
              Effect.flatMap(Jj, (j) => j.status()),
              layerNoop({ status: () => Effect.succeed("ok-status") })
            )
            if (overridden !== "ok-status") return false

            const branded = makeJj(noop)
            if (branded !== noop) return false

            const safeRef = input.refName.replaceAll("'", "x")
            if (input.lockKind === "index_lock") {
              const msg =
                `Could not acquire lock for index file '/repo/.git/index.lock': lock could not be obtained immediately after ${input.attempts} attempt(s)`
              if (!isGitLockContention({ message: msg })) return false
            } else if (input.lockKind === "ref_lock") {
              const msg = `cannot lock ref '${safeRef}': Unable to create lock: File exists`
              if (!isGitLockContention({ message: msg })) return false
            } else if (input.lockKind === "private_index") {
              const msg =
                `Could not acquire lock for index file '/tmp/private-index': could not be obtained immediately after ${input.attempts} attempt(s)`
              if (isGitLockContention({ message: msg })) return false
            } else if (input.lockKind === "conflict") {
              if (isGitLockContention({ message: `Error: would leave conflicts in ${input.noise}` })) return false
            } else {
              isGitLockContention({ message: input.noise })
            }
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })

  it("Repository validation, Git object hashing, tree sorting, and in-memory CAS transactions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        blobA: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
        blobB: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
        nameA: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20))),
        nameB: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20))),
        modeA: Schema.Literals(["100644", "100755", "120000", "040000", "160000"]),
        modeB: Schema.Literals(["100644", "100755", "120000", "040000", "160000"]),
        seconds: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2_000_000_000 }))),
        rawRef: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
        rawOid: Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        opId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(24)))
      })
    )

    const cleanName = (s: string, fallback: string) => {
      const cleaned = s.replace(/[/\0]/g, "_").slice(0, 32)
      return cleaned === "" || cleaned === "." || cleaned === ".." ? fallback : cleaned
    }

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            if (Repository.isObjectId("not-an-oid")) return false
            if (Repository.isObjectId("A".repeat(40))) return false
            if (!Repository.isObjectId(Repository.EMPTY_TREE)) return false
            if (Repository.isRefName("refs/heads/a..b")) return false
            if (Repository.isRefName("refs/heads/.hidden")) return false
            if (Repository.isRefName("refs/heads/main.lock")) return false
            if (Repository.isRefName("heads/main")) return false
            if (!Repository.isRefName("refs/heads/main")) return false
            Repository.isRefName(input.rawRef)
            Repository.isObjectId(input.rawOid)

            const emptyHash = yield* Repository.hashTree([])
            if (emptyHash !== Repository.EMPTY_TREE) return false

            const h1 = yield* Repository.hashBlob(input.blobA)
            const h2 = yield* Repository.hashBlob(input.blobA)
            if (h1 !== h2 || !Repository.isObjectId(h1)) return false

            const repo = Repository.makeMemory()
            const wroteBlobA = yield* repo.writeBlob(input.blobA)
            const wroteBlobB = yield* repo.writeBlob(input.blobB)
            const subTree = yield* repo.writeTree([])
            if (wroteBlobA !== h1 || subTree !== Repository.EMPTY_TREE) return false
            const readBack = yield* repo.readBlob(wroteBlobA)
            if (readBack !== input.blobA) return false

            const nA = cleanName(input.nameA, "a.txt")
            let nB = cleanName(input.nameB, "b.txt")
            if (nB === nA) nB = `${nB}_2`

            const oidFor = (mode: Repository.Mode, blobOid: Repository.ObjectId) =>
              mode === "040000" ? subTree : blobOid

            const entries1: ReadonlyArray<Repository.TreeEntry> = [
              { name: nA, mode: input.modeA, oid: oidFor(input.modeA, wroteBlobA) },
              { name: nB, mode: input.modeB, oid: oidFor(input.modeB, wroteBlobB) }
            ]
            const entries2: ReadonlyArray<Repository.TreeEntry> = [entries1[1]!, entries1[0]!]
            const t1 = yield* Repository.hashTree(entries1)
            const t2 = yield* Repository.hashTree(entries2)
            if (t1 !== t2) return false

            const dupExit = yield* Effect.exit(
              Repository.requireEntries("writeTree", [entries1[0]!, entries1[0]!])
            )
            if (!Exit.isFailure(dupExit)) return false
            const dupErr = Cause.squash(dupExit.cause)
            if (!Repository.isRepositoryError(dupErr) || dupErr.code !== "invalid") return false

            const wroteTree = yield* repo.writeTree(entries1)
            if (wroteTree !== t1) return false
            const readTree = yield* repo.readTree(wroteTree)
            if (readTree.length !== 2) return false

            const person: Repository.Person = {
              name: "Alice",
              email: "alice@example.com",
              seconds: input.seconds
            }
            const commitObj: Repository.CommitObject = {
              tree: wroteTree,
              parents: [],
              author: person,
              committer: person,
              message: input.blobB
            }
            const commitOid = yield* repo.writeCommit(commitObj)
            const expectedCommitOid = yield* Repository.hashCommit(commitObj)
            if (commitOid !== expectedCommitOid) return false

            const header = yield* repo.readCommit(commitOid.slice(0, 7))
            if (header.oid !== commitOid || header.tree !== wroteTree) return false

            const ref = "refs/heads/fuzz-branch"
            const safeOp = input.opId.replace(/[^A-Za-z0-9._:/-]/g, "x") || "op1"
            yield* repo.updateRefs({
              operation: safeOp,
              updates: [{ ref, before: null, after: commitOid }]
            })
            const refs1 = yield* repo.readRefs([ref])
            if (refs1[0]?.oid !== commitOid) return false

            const conflictExit = yield* Effect.exit(
              repo.updateRefs({
                operation: `${safeOp}-2`,
                updates: [{ ref, before: null, after: subTree }]
              })
            )
            if (!Exit.isFailure(conflictExit)) return false
            const conflictErr = Cause.squash(conflictExit.cause)
            if (!Repository.isRepositoryError(conflictErr) || conflictErr.code !== "conflict") return false
            const refsAfter = yield* repo.readRefs([ref])
            if (refsAfter[0]?.oid !== commitOid) return false

            // Delete ref via after: null
            yield* repo.updateRefs({
              operation: `${safeOp}-del`,
              updates: [{ ref, before: commitOid, after: null }]
            })
            const refsDeleted = yield* repo.readRefs([ref])
            if (refsDeleted[0]?.oid !== null) return false

            // Layer helpers
            const viaLayer = yield* Effect.provide(
              Effect.flatMap(Repository.Repository, (r) => r.writeBlob(input.blobA)),
              Repository.layerMemory()
            )
            if (viaLayer !== h1) return false

            const unsupExit = yield* Effect.exit(
              Effect.provide(
                Effect.flatMap(Repository.Repository, (r) => r.readBlob(h1)),
                Repository.layerUnsupported("no remote")
              )
            )
            if (!Exit.isFailure(unsupExit)) return false
            const unsupErr = Cause.squash(unsupExit.cause)
            if (!Repository.isRepositoryError(unsupErr) || unsupErr.code !== "unsupported") return false

            const badAns = yield* Effect.exit(Repository.requireAnswer("writeBlob", h1, "wrong-oid"))
            if (!Exit.isFailure(badAns)) return false

            const badOidExit = yield* Effect.exit(Repository.requireObjectId("readBlob", "xyz"))
            if (!Exit.isFailure(badOidExit)) return false
            const badRevExit = yield* Effect.exit(Repository.requireRevision("readCommit", "ab"))
            if (!Exit.isFailure(badRevExit)) return false

            const badCommitExit = yield* Effect.exit(
              Repository.requireCommit("writeCommit", {
                ...commitObj,
                author: { name: "Bad<Name>", email: "x@y", seconds: 0 }
              })
            )
            if (!Exit.isFailure(badCommitExit)) return false

            const tooMany = Array.from({ length: Repository.MAX_REF_UPDATES + 1 }, (_, i) => ({
              ref: `refs/heads/b${i}`,
              before: null,
              after: commitOid
            }))
            const tooManyExit = yield* Effect.exit(
              Repository.requireTransaction("updateRefs", { operation: "op", updates: tooMany })
            )
            if (!Exit.isFailure(tooManyExit)) return false

            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("Repository.makeMemory concurrent CAS updateRefs is linearizable under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nCompetitors: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 2, maximum: 5 }))),
        seedOffset: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10000 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const HEX = "0123456789abcdef"
            const mkOid = (n: number) => {
              let h = ""
              let x = (n >>> 0) || 1
              for (let j = 0; j < 40; j++) {
                x = (Math.imul(x, 1664525) + 1013904223) >>> 0
                h += HEX[x & 15]
              }
              return h
            }
            const targets = Array.from({ length: input.nCompetitors }, (_, i) => mkOid(input.seedOffset * 31 + i + 1))
            const repo = Repository.makeMemory({
              commits: targets.map((id) => ({ id, tree: Repository.EMPTY_TREE }))
            })
            const ref = "refs/heads/race"

            const results = yield* Effect.all(
              targets.map((target, i) =>
                Effect.exit(
                  repo.updateRefs({
                    operation: `race-${i}`,
                    updates: [{ ref, before: null, after: target }]
                  })
                )
              ),
              { concurrency: "unbounded" }
            )

            const winners = results.filter(Exit.isSuccess)
            const losers = results.filter(Exit.isFailure)
            if (winners.length !== 1) return false
            if (losers.length !== input.nCompetitors - 1) return false
            for (const l of losers) {
              const err = Cause.squash(l.cause)
              if (!Repository.isRepositoryError(err) || err.code !== "conflict") return false
            }
            const [finalRef] = yield* repo.readRefs([ref])
            if (finalRef === undefined || finalRef.oid === null) return false
            return targets.includes(finalRef.oid)
          }),
        { seed: seed + 3, executions, execution: FuzzSimulation.execution() }
      )
    )
    assertPassed(report)
  })

  it("quoteGitPatchPaths is idempotent, preserves hunk bodies, and rejects mismatched metadata", async () => {
    const pathCharArb = Schema.Literals([
      "a",
      "b",
      " ",
      "\t",
      "\"",
      "\\",
      "/",
      "-",
      "é",
      "\x01",
      "\x7f"
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        srcChars: Schema.Array(pathCharArb).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        dstChars: Schema.Array(pathCharArb).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        kind: Schema.Literals([
          "modify",
          "add",
          "delete",
          "rename",
          "copy",
          "binary",
          "bad_meta_odd",
          "bad_meta_type",
          "bad_header",
          "trailing_junk"
        ]),
        hunkLine: Schema.String.pipe(Schema.check(Schema.isMaxLength(64)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const src = input.srcChars.join("")
            const dst = input.dstChars.join("")
            const safeHunk = input.hunkLine.replace(/\r|\n/g, " ")
            const metadata = `${JSON.stringify(src)}\n${JSON.stringify(dst)}\n`

            if (input.kind === "bad_meta_odd") {
              try {
                quoteGitPatchPaths("", `${JSON.stringify(src)}\n`)
                return false
              } catch (e) {
                return e instanceof JjInternalFault && e.code === "patch_path_metadata_incomplete"
              }
            }
            if (input.kind === "bad_meta_type") {
              try {
                quoteGitPatchPaths("", "123\n456\n")
                return false
              } catch (e) {
                return e instanceof JjInternalFault && e.code === "patch_path_metadata_invalid"
              }
            }
            if (input.kind === "bad_header") {
              try {
                quoteGitPatchPaths("diff --git a/wrong b/wrong\n", metadata)
                return false
              } catch (e) {
                return e instanceof JjInternalFault && e.code === "patch_headers_disagree"
              }
            }
            if (input.kind === "trailing_junk") {
              try {
                quoteGitPatchPaths("unexpected output", "")
                return false
              } catch (e) {
                return e instanceof JjInternalFault && e.code === "patch_output_unexpected"
              }
            }

            let patch = `diff --git a/${src} b/${dst}\n`
            if (input.kind === "add") {
              patch += `new file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${dst}\n@@ -0,0 +1,1 @@\n+${safeHunk}\n`
            } else if (input.kind === "delete") {
              patch += `deleted file mode 100644\nindex 1111111..0000000\n--- a/${src}\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-${safeHunk}\n`
            } else if (input.kind === "rename") {
              patch += `rename from ${src}\nrename to ${dst}\n`
            } else if (input.kind === "copy") {
              patch += `copy from ${src}\ncopy to ${dst}\n`
            } else if (input.kind === "binary") {
              patch += `Binary files a/${src} and b/${dst} differ\n`
            } else {
              patch += `index 1111111..2222222 100644\n--- a/${src}\n+++ b/${dst}\n@@ -1,2 +1,2 @@\n-diff --git a/fake b/fake\n+${safeHunk}\n`
            }

            const once = quoteGitPatchPaths(patch, metadata)
            const twice = quoteGitPatchPaths(once, metadata)
            if (once !== twice) return false
            if (input.kind === "modify" && !once.includes("-diff --git a/fake b/fake")) return false
            return true
          }),
        { seed: seed + 4, executions }
      )
    )
    assertPassed(report)
  })

  it("resolveJjBinary never picks relative PATH entries, honors authoritative overrides, and quotes hints safely", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        overrideVal: Schema.Union([
          Schema.Undefined,
          Schema.Literals(["", "/custom/jj", "/missing/jj", "rel/jj", "/dir/with 'quote' & $(id)/jj"])
        ]),
        overrideExists: Schema.Boolean,
        overrideExec: Schema.Boolean,
        pathExec: Schema.Boolean,
        platform: Schema.Literals(["darwin", "linux", "win32"]),
        rawQuote: Schema.String.pipe(Schema.check(Schema.isMaxLength(64)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const quoted = ResolveJjBinary.shellQuote(input.rawQuote)
            if (!quoted.startsWith("'") || !quoted.endsWith("'")) return false

            const hint = ResolveJjBinary.permissionHint(input.rawQuote, input.platform)
            if (!hint.includes(quoted)) return false
            if (input.platform === "darwin" && !hint.includes("quarantine")) return false
            if (input.platform !== "darwin" && hint.includes("quarantine")) return false

            const isExecOk = ResolveJjBinary.isExecutable("/bin/jj", {
              platform: input.platform,
              access: () => {}
            })
            if (!isExecOk) return false
            const isExecBad = ResolveJjBinary.isExecutable("/bin/jj", {
              platform: input.platform,
              access: () => {
                throw new Error("EACCES")
              }
            })
            if (isExecBad) return false

            const environment: Record<string, string | undefined> = {
              PATH: `.:./relative:/abs/bin`
            }
            if (input.overrideVal !== undefined) {
              environment.SMITHERS_JJ_PATH = input.overrideVal
            }

            const existing = new Set<string>()
            const executable = new Set<string>()
            const hasOverride = input.overrideVal !== undefined && input.overrideVal !== ""
            if (hasOverride && input.overrideExists) {
              const resolvedOverride = resolve(input.overrideVal!)
              existing.add(resolvedOverride)
              if (input.overrideExec) executable.add(resolvedOverride)
            }
            existing.add("jj")
            executable.add("jj")
            existing.add("./relative/jj")
            executable.add("./relative/jj")
            if (input.pathExec) {
              existing.add("/abs/bin/jj")
              executable.add("/abs/bin/jj")
            }

            const resolved = ResolveJjBinary.resolveJjBinary({
              environment,
              platform: input.platform === "win32" ? "linux" : input.platform,
              exists: (p) => existing.has(p),
              executable: (p) => executable.has(p)
            })

            const desc = ResolveJjBinary.describe(resolved)
            if (desc.length === 0) return false

            if (resolved.path === "./relative/jj" || resolved.path === "./jj") return false

            if (hasOverride && input.overrideExists) {
              if (resolved.source !== "env") return false
              if (resolved.executable !== input.overrideExec) return false
              if (!input.overrideExec && resolved.hint === undefined) return false
            } else if (hasOverride && !input.overrideExists) {
              if (resolved.ignored === undefined || resolved.ignored.variable !== "SMITHERS_JJ_PATH") return false
            }

            return true
          }),
        { seed: seed + 5, executions }
      )
    )
    assertPassed(report)
  })

  it("WasiPreview1 enforces preopen sandbox isolation, syscall roundtrips, and POSIX errno mapping", async () => {
    const wasiDir = join(tempRoot, "wasi-root")
    nodeFs.mkdirSync(wasiDir, { recursive: true })

    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["escape", "rw_cycle", "dir_ops", "errno_map", "meta_exit", "pread_pwrite_dispose"]),
        filename: Schema.Literals(["a.txt", "sub/b.txt", "file-1.dat", "nested/deep/c.txt"]),
        escapePath: Schema.Literals([
          "../outside.txt",
          "/etc/passwd",
          "a/../../outside.txt",
          "bad\0name",
          "../../../../../tmp/x"
        ]),
        payload: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
        exitCode: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
        errnoCode: Schema.Literals([
          "ENOENT",
          "EEXIST",
          "EACCES",
          "EPERM",
          "EISDIR",
          "ENOTDIR",
          "ENOTEMPTY",
          "EINVAL",
          "EBADF",
          "ENOLCK",
          "ENOSPC",
          "EROFS",
          "ELOOP",
          "ENAMETOOLONG"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const iterDir = nodeFs.mkdtempSync(join(wasiDir, "iter-"))
            try {
              const memory = new WebAssembly.Memory({ initial: 2 })
              const writeStr = (at: number, text: string) => {
                const bytes = encoder.encode(text)
                new Uint8Array(memory.buffer, at, bytes.length).set(bytes)
                return { ptr: at, len: bytes.length }
              }
              const view = () => new DataView(memory.buffer)

              if (input.mode === "errno_map") {
                const failingFs: SyncFsLike = {
                  ...nodeFs,
                  statSync: () => {
                    throw Object.assign(new Error(input.errnoCode), { code: input.errnoCode })
                  },
                  lstatSync: () => {
                    throw Object.assign(new Error(input.errnoCode), { code: input.errnoCode })
                  }
                }
                const wasi = makeWasi({
                  fs: failingFs,
                  root: iterDir
                })
                wasi.initialize(memory)
                const sys = wasi.imports
                const p = writeStr(0x100, "any.txt")
                const rc = sys.path_filestat_get!(3, 0, p.ptr, p.len, 0x400)
                wasi.dispose()
                return rc !== Errno.success
              }

              const stdoutChunks: Array<string> = []
              const stderrChunks: Array<string> = []
              const wasi = makeWasi({
                fs: nodeFs,
                root: iterDir,
                onStdout: (s) => stdoutChunks.push(s),
                onStderr: (s) => stderrChunks.push(s)
              })
              wasi.initialize(memory)
              const sys = wasi.imports

              if (input.mode === "escape") {
                // Even if chroot-clamped inside iterDir, must NEVER create or access anything outside iterDir
                const p = writeStr(0x100, input.escapePath)
                sys.path_open!(3, 0, p.ptr, p.len, 1, 1n << 1n, 0n, 0, 0x300)
                wasi.dispose()
                if (nodeFs.existsSync(join(wasiDir, "outside.txt"))) return false
                if (nodeFs.existsSync(join(tempRoot, "outside.txt"))) return false
                if (input.escapePath.includes("\0")) {
                  // NUL byte paths must always be rejected
                  const p2 = writeStr(0x100, input.escapePath)
                  const wasi2 = makeWasi({ fs: nodeFs, root: iterDir })
                  wasi2.initialize(memory)
                  const rc2 = wasi2.imports.path_open!(3, 0, p2.ptr, p2.len, 1, 1n << 1n, 0n, 0, 0x300)
                  wasi2.dispose()
                  if (rc2 === Errno.success) return false
                }
                return true
              }

              if (input.mode === "meta_exit") {
                if (sys.args_sizes_get!(0x100, 0x104) !== Errno.success) return false
                if (sys.args_get!(0x200, 0x240) !== Errno.success) return false
                if (sys.environ_sizes_get!(0x108, 0x10c) !== Errno.success) return false
                if (sys.environ_get!(0x300, 0x340) !== Errno.success) return false
                if (sys.clock_time_get!(0, 0n, 0x400) !== Errno.success) return false
                if (sys.clock_res_get!(0, 0x410) !== Errno.success) return false
                if (sys.random_get!(0x500, 16) !== Errno.success) return false
                if (sys.sched_yield!() !== Errno.success) return false
                if (sys.fd_prestat_get!(3, 0x600) !== Errno.success) return false
                if (sys.fd_prestat_dir_name!(3, 0x620, 1) !== Errno.success) return false
                // Write to stdout (fd 1) and stderr (fd 2)
                const msg = writeStr(0x700, "hello")
                view().setUint32(0x720, msg.ptr, true)
                view().setUint32(0x724, msg.len, true)
                if (sys.fd_write!(1, 0x720, 1, 0x730) !== Errno.success) return false
                if (sys.fd_write!(2, 0x720, 1, 0x734) !== Errno.success) return false
                if (stdoutChunks.join("") !== "hello" || stderrChunks.join("") !== "hello") return false
                try {
                  sys.proc_exit!(input.exitCode)
                  return false
                } catch (e) {
                  wasi.dispose()
                  return e instanceof WasiExitError && e.exitCode === input.exitCode
                }
              }

              if (input.mode === "dir_ops") {
                const d = writeStr(0x100, "subdir")
                if (sys.path_create_directory!(3, d.ptr, d.len) !== Errno.success) return false
                const d2 = writeStr(0x180, "subdir-renamed")
                if (sys.path_rename!(3, d.ptr, d.len, 3, d2.ptr, d2.len) !== Errno.success) return false
                if (sys.fd_readdir!(3, 0x400, 512, 0n, 0x300) !== Errno.success) return false
                if (sys.path_remove_directory!(3, d2.ptr, d2.len) !== Errno.success) return false
                wasi.dispose()
                return true
              }

              const parts = input.filename.split("/")
              for (let i = 0; i < parts.length - 1; i++) {
                const sub = writeStr(0x100, parts.slice(0, i + 1).join("/"))
                sys.path_create_directory!(3, sub.ptr, sub.len)
              }
              const p = writeStr(0x100, input.filename)
              const OFLAG_CREAT_TRUNC = 1 | 8
              const RW = (1n << 1n) | (1n << 6n)
              const openRc = sys.path_open!(3, 0, p.ptr, p.len, OFLAG_CREAT_TRUNC, RW, 0n, 0, 0x300)
              if (openRc !== Errno.success) return false
              const fd = view().getUint32(0x300, true)

              const dataBytes = encoder.encode(input.payload)
              new Uint8Array(memory.buffer, 0x1000, dataBytes.length).set(dataBytes)
              view().setUint32(0x320, 0x1000, true)
              view().setUint32(0x324, dataBytes.length, true)

              if (input.mode === "pread_pwrite_dispose") {
                if (sys.fd_pwrite!(fd, 0x320, 1, 0n, 0x330) !== Errno.success) return false
                view().setUint32(0x350, 0x2000, true)
                view().setUint32(0x354, dataBytes.length + 16, true)
                if (sys.fd_pread!(fd, 0x350, 1, 0n, 0x360) !== Errno.success) return false
                const nread = view().getUint32(0x360, true)
                if (decoder.decode(new Uint8Array(memory.buffer, 0x2000, nread)) !== decoder.decode(dataBytes)) return false
                if (sys.fd_datasync!(fd) !== Errno.success) return false
                if (sys.fd_sync!(fd) !== Errno.success) return false
                if (sys.fd_filestat_set_size!(fd, 0n) !== Errno.success) return false
                wasi.dispose()
                wasi.dispose() // idempotent
                return sys.fd_close!(fd) === Errno.badf
              }

              if (sys.fd_write!(fd, 0x320, 1, 0x330) !== Errno.success) return false
              const written = view().getUint32(0x330, true)
              if (written !== dataBytes.length) return false

              if (sys.fd_seek!(fd, 0n, 0, 0x340) !== Errno.success) return false
              if (sys.fd_tell!(fd, 0x348) !== Errno.success) return false
              if (view().getBigUint64(0x348, true) !== 0n) return false

              view().setUint32(0x350, 0x2000, true)
              view().setUint32(0x354, dataBytes.length + 16, true)
              if (sys.fd_read!(fd, 0x350, 1, 0x360) !== Errno.success) return false
              const nread = view().getUint32(0x360, true)
              const readBack = decoder.decode(new Uint8Array(memory.buffer, 0x2000, nread))
              if (readBack !== decoder.decode(dataBytes)) return false

              if (sys.fd_filestat_get!(fd, 0x500) !== Errno.success) return false
              if (sys.fd_fdstat_get!(fd, 0x580) !== Errno.success) return false
              if (sys.path_filestat_get!(3, 0, p.ptr, p.len, 0x600) !== Errno.success) return false
              if (sys.fd_close!(fd) !== Errno.success) return false
              if (sys.path_unlink_file!(3, p.ptr, p.len) !== Errno.success) return false
              wasi.dispose()
              return true
            } finally {
              nodeFs.rmSync(iterDir, { recursive: true, force: true })
            }
          }),
        { seed: seed + 6, executions }
      )
    )
    assertPassed(report)
  })

  it("BrowserJj handles ABI responses, error codes, malformed JSON, and layerUnsupported", async () => {
    const slice: SyncFsLike = {
      ...nodeFs,
      statSync: () => nodeFs.statSync(import.meta.filename),
      lstatSync: () => nodeFs.lstatSync(import.meta.dirname),
      readdirSync: () => [],
      unlinkSync: (path: string): void => {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
      }
    }

    const arb = Arbitrary.schema(
      Schema.Struct({
        op: Schema.Literals([
          "snapshot",
          "restore",
          "diff",
          "status",
          "workspaceAdd",
          "workspaceForget",
          "opRestore"
        ]),
        outcome: Schema.Literals(["ok", "err_code", "malformed_json", "unsupported_layer"]),
        errCode: JjErrorCode,
        text: Schema.String.pipe(Schema.check(Schema.isMaxLength(40)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const callOp = (jj: Jj) => {
              switch (input.op) {
                case "snapshot":
                  return jj.snapshot(input.text)
                case "restore":
                  return jj.restore("rev1")
                case "diff":
                  return jj.diff("rev1", "rev2")
                case "status":
                  return jj.status()
                case "workspaceAdd":
                  return jj.workspaceAdd("ws1", "/work/ws")
                case "workspaceForget":
                  return jj.workspaceForget("ws1")
                case "opRestore":
                  return jj.opRestore!("op1")
              }
            }

            if (input.outcome === "unsupported_layer") {
              const exit = yield* Effect.exit(
                Effect.provide(Effect.flatMap(Jj, callOp), BrowserJj.layerUnsupported)
              )
              if (!Exit.isFailure(exit)) return false
              const err = Cause.squash(exit.cause)
              return isJjError(err) && err.code === "not_installed"
            }

            const safeText = input.text.replace(/[\r\n]/g, " ")
            const response = input.outcome === "ok"
              ? JSON.stringify({
                ok: {
                  commitId: "0a1b2c3d",
                  changeId: "qpvuntsm",
                  operationId: "op123456",
                  diff: `diff --git a/f b/f\n+${safeText}\n`,
                  status: safeText,
                  root: "/work"
                }
              })
              : input.outcome === "err_code"
              ? JSON.stringify({
                err: {
                  code: input.errCode,
                  message: safeText || "failed"
                }
              })
              : "{not-valid-json"

            const wasm = fakeFlowsJjWasm({ response })
            const exit = yield* Effect.exit(
              Effect.scoped(
                Effect.flatMap(BrowserJj.makeScoped({ wasm, fs: slice }), callOp)
              )
            )

            if (input.outcome === "ok") {
              return Exit.isSuccess(exit)
            }
            if (!Exit.isFailure(exit)) return false
            const err = Cause.squash(exit.cause)
            if (!isJjError(err)) return false
            if (input.outcome === "err_code") {
              return err.code === input.errCode
            }
            return err.code === "unknown"
          }),
        { seed: seed + 7, executions }
      )
    )
    assertPassed(report)
  })

  it("NodeJj & BunJj layerSpawner classify version probes, errors, and command outputs", async () => {
    const fakeBin = join(tempRoot, "fake-jj")
    nodeFs.writeFileSync(fakeBin, "#!/bin/sh\necho 'jj 0.39.0'\n")
    nodeFs.chmodSync(fakeBin, 0o755)
    const fakeRepo = join(tempRoot, "fake-repo")
    nodeFs.mkdirSync(join(fakeRepo, ".jj", "repo"), { recursive: true })

    const prevEnv = process.env.SMITHERS_JJ_PATH
    process.env.SMITHERS_JJ_PATH = fakeBin

    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scenario: Schema.Literals([
            "status_ok",
            "old_version",
            "conflict_err",
            "invalid_ref_err",
            "snapshot_refused",
            "stale_workspace",
            "unknown_err",
            "spawn_enoent",
            "bun_status_ok",
            "revert_ok",
            "op_restore_ok",
            "workspace_forget_ok"
          ]),
          payload: Schema.String.pipe(Schema.check(Schema.isMaxLength(40)))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.gen(function*() {
              const safePayload = decoder.decode(encoder.encode(input.payload.replace(/[\r\n"]/g, " ")))
              const spawner = makeSpawner((command) => {
                const args = command._tag === "StandardCommand" ? command.args : []
                const isVersion = args.includes("--version")
                if (input.scenario === "spawn_enoent") {
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "ChildProcess",
                      method: "spawn",
                      pathOrDescriptor: fakeBin,
                      description: "ENOENT"
                    })
                  )
                }

                let stdout = ""
                let stderr = ""
                let code = 0

                if (isVersion) {
                  stdout = input.scenario === "old_version" ? "jj 0.38.0\n" : "jj 0.39.0\n"
                } else if (input.scenario === "revert_ok") {
                  if (args.includes("diff")) stdout = `"a.txt"\n"b.txt"\n`
                  else stdout = ""
                } else if (input.scenario === "op_restore_ok" || input.scenario === "workspace_forget_ok") {
                  stdout = ""
                } else {
                  switch (input.scenario) {
                    case "status_ok":
                    case "bun_status_ok":
                      stdout = `working copy ${safePayload}\n`
                      break
                    case "conflict_err":
                      stderr = "Error: The merge would leave conflicts\n"
                      code = 1
                      break
                    case "invalid_ref_err":
                      stderr = "Error: Revision not found\n"
                      code = 1
                      break
                    case "snapshot_refused":
                      stderr = "Warning: Refused to snapshot some files:\n  big.bin: 2MiB\n"
                      code = 0
                      break
                    case "stale_workspace":
                      stderr = "Error: The working copy is stale (not updated since operation abc)\n"
                      code = 1
                      break
                    case "unknown_err":
                      stderr = `Error: unexpected ${safePayload}\n`
                      code = 2
                      break
                    default:
                      stdout = "ok\n"
                  }
                }

                return Effect.succeed(
                  makeHandle({
                    pid: ProcessId(12345),
                    exitCode: Effect.succeed(ExitCode(code)),
                    isRunning: Effect.succeed(false),
                    kill: () => Effect.void,
                    unref: Effect.succeed(Effect.void),
                    stdin: Stream.empty as never,
                    stdout: Stream.make(encoder.encode(stdout)),
                    stderr: Stream.make(encoder.encode(stderr)),
                    all: Stream.make(encoder.encode(stdout + stderr)),
                    getInputFd: () => Stream.empty as never,
                    getOutputFd: () => Stream.empty
                  })
                )
              })

              const layer = input.scenario === "bun_status_ok"
                ? BunJj.layerSpawnerAt(fakeRepo).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner, spawner)))
                : NodeJj.layerSpawnerAt(fakeRepo).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner, spawner)))

              const exit = yield* Effect.exit(
                Effect.provide(
                  Effect.flatMap(Jj, (j): Effect.Effect<unknown, unknown> => {
                    if (input.scenario === "revert_ok") return j.revert!("abc12345")
                    if (input.scenario === "op_restore_ok") return j.opRestore!("0123456789abcdef")
                    if (input.scenario === "workspace_forget_ok") return j.workspaceForget("lane-1")
                    return j.status()
                  }),
                  layer
                )
              )

              switch (input.scenario) {
                case "status_ok":
                case "bun_status_ok":
                  return Exit.isSuccess(exit) && typeof exit.value === "string" && exit.value.includes(safePayload)
                case "revert_ok":
                  return Exit.isSuccess(exit)
                case "op_restore_ok":
                case "workspace_forget_ok":
                  return Exit.isSuccess(exit)
                case "old_version": {
                  if (!Exit.isFailure(exit)) return false
                  const err = Cause.squash(exit.cause)
                  return isJjError(err) && err.code === "unsupported_version"
                }
                case "conflict_err": {
                  if (!Exit.isFailure(exit)) return false
                  const err = Cause.squash(exit.cause)
                  return isJjError(err) && err.code === "conflict"
                }
                case "invalid_ref_err": {
                  if (!Exit.isFailure(exit)) return false
                  const err = Cause.squash(exit.cause)
                  return isJjError(err) && err.code === "invalid_ref"
                }
                case "snapshot_refused": {
                  if (!Exit.isFailure(exit)) return false
                  const err = Cause.squash(exit.cause)
                  return isJjError(err) && err.code === "snapshot_refused"
                }
                case "stale_workspace": {
                  if (!Exit.isFailure(exit)) return false
                  const err = Cause.squash(exit.cause)
                  return isJjError(err) && err.code === "stale_workspace"
                }
                case "unknown_err": {
                  if (!Exit.isFailure(exit)) return false
                  const err = Cause.squash(exit.cause)
                  return isJjError(err) && err.code === "unknown"
                }
                case "spawn_enoent": {
                  if (!Exit.isFailure(exit)) return false
                  const err = Cause.squash(exit.cause)
                  return isJjError(err) && err.code === "not_installed"
                }
              }
            }),
          { seed: seed + 8, executions }
        )
      )
      assertPassed(report)
    } finally {
      if (prevEnv === undefined) delete process.env.SMITHERS_JJ_PATH
      else process.env.SMITHERS_JJ_PATH = prevEnv
    }
  })

  it.skipIf(!jjAvailable)("Real NodeJj.layerAt & RepositoryMutation roundtrip on a temporary jj repo", async () => {
    const repoDir = nodeFs.mkdtempSync(join(tempRoot, "real-jj-"))
    execFileSync("jj", ["git", "init", repoDir], { stdio: "ignore" })
    execFileSync("jj", ["config", "set", "--repo", "user.name", "Fuzz"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("jj", ["config", "set", "--repo", "user.email", "fuzz@example.com"], {
      cwd: repoDir,
      stdio: "ignore"
    })

    const arb = Arbitrary.schema(
      Schema.Struct({
        content: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(48))),
        msg: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32)))
      })
    )

    const realExecutions = Math.min(executions, 8)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const safeMsg = input.msg.replace(/[\r\n\0]/g, " ").trim() || "snap"
            const safeContent = input.content.replace(/\0/g, "x")
            nodeFs.writeFileSync(join(repoDir, "note.txt"), safeContent)

            const layer = Layer.mergeAll(NodeJj.layerAt(repoDir), NodeJj.layerRepositoryMutation)
            return yield* Effect.provide(
              Effect.gen(function*() {
                const jj = yield* Jj
                const mut = yield* RepositoryMutation
                const snap1 = yield* jj.snapshot(safeMsg)
                if (!snap1.commitId || !snap1.changeId || !snap1.operationId) return false
                const root = yield* jj.root!(repoDir)
                if (!root) return false
                const status = yield* jj.status()
                if (typeof status !== "string") return false

                const fenced = yield* mut.run("fuzz-check", repoDir, Effect.succeed("fenced-ok"))
                if (fenced !== "fenced-ok") return false

                nodeFs.writeFileSync(join(repoDir, "note.txt"), `${safeContent}-modified`)
                const snap2 = yield* jj.snapshot(`${safeMsg}-2`)
                const diff = yield* jj.diff(snap1.commitId, snap2.commitId)
                if (!diff.includes("note.txt")) return false

                yield* jj.restore(snap1.commitId)
                const restored = nodeFs.readFileSync(join(repoDir, "note.txt"), "utf8")
                return restored === safeContent
              }),
              layer
            )
          }),
        { seed: seed + 9, executions: realExecutions }
      )
    )
    assertPassed(report)
  }, 60_000)
})
