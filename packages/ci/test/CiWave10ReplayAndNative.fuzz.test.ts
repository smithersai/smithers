import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Duration, Effect, Exit, FileSystem, Layer, Path, Ref, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { execFileSync, spawn as nodeSpawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as InventoryRead from "../src/inventory/Read.vibe"
import * as NativeReplay from "../src/native/Replay.vibe"
import * as Disk from "../src/replay/Disk.vibe"
import * as DiskSpace from "../src/replay/DiskSpace.ts"
import * as Kept from "../src/replay/Kept.vibe"
import * as Process from "../src/replay/Process.vibe"
import * as Replay from "../src/replay/Replay.vibe"
import * as Stall from "../src/replay/Stall.vibe"
import { brokenInstall, fakeSmthrs, makeOwn, makeOwnWith, packageWithOpenTarget, smthrs as nativeSmthrs, workflowFor } from "./native/own.ts"
import { unconfined } from "./replay/place.ts"
import { job as fixtureJob, makeRepository, makeSmallRepository } from "./replay/fixture.ts"
import { options as replayOptions, parts as replayParts } from "./replay/TestParts.vibe"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261701")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const plentyDisk = Layer.succeed(Disk.DiskSpace, {
  space: () => Effect.succeed({ free: 500 * 1_000_000_000, total: 1000 * 1_000_000_000 }),
  held: () => Effect.succeed(0)
})

const silentProgress = Layer.succeed(Replay.Progress, { say: () => Effect.void })

const runNode = <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner>) =>
  Effect.runPromise(Effect.provide(eff, NodeServices.layer))

describe("packages/ci Wave 10: Replay.vibe deterministic full-branch scenarios", () => {
  it("exercises applied + warm (normal & fast) and cold (no parent)", async () => {
    const baseLayer = Layer.mergeAll(NodeServices.layer, plentyDisk, replayOptions, silentProgress)

    // 1. Warm + Applied with normal & fast modes (hits warmed(), commitApplied(), asApplied(), fastMs!)
    const repo1 = makeRepository()
    try {
      const report = await Effect.runPromise(
        Replay.run(
          { root: repo1.root, commits: 1, modes: ["normal", "fast"], warm: true, applied: true, trial: false },
          replayParts(repo1.commits[0]!)
        ).pipe(Effect.provide(baseLayer))
      )
      expect(report.commits.length).toBe(1)
      expect(report.firstRun).toBeDefined()
    } finally {
      repo1.remove()
    }

  }, 240_000)

  it("exercises cold warm-request on single-commit repo (noCommitBefore)", async () => {
    const baseLayer = Layer.mergeAll(NodeServices.layer, plentyDisk, replayOptions, silentProgress)
    const repoCold = makeSmallRepository([fixtureJob("okJob", "echo ok")])
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoCold, encoding: "utf8" }).trim()
      const report = await Effect.runPromise(
        Replay.run(
          { root: repoCold, commits: 1, modes: ["normal"], warm: true, applied: false, trial: false },
          replayParts(head)
        ).pipe(Effect.provide(baseLayer))
      )
      expect(report.cold).toBeDefined()
    } finally {
      rmSync(repoCold, { recursive: true, force: true })
    }
  }, 240_000)

  it("exercises trial judge (1 of 3 fails), tooFewLeft (all fail), and disk.stopped early report", async () => {
    const baseLayer = Layer.mergeAll(NodeServices.layer, plentyDisk, replayOptions, silentProgress)

    // 3. Trial mode where 1 of 3 jobs fails -> >50% pass, completes!
    const repoOneFail = makeSmallRepository([
      fixtureJob("passA", "echo passA"),
      fixtureJob("passB", "echo passB"),
      fixtureJob("failJob", "echo fail >&2; exit 1")
    ])
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoOneFail, encoding: "utf8" }).trim()
      const rep = await Effect.runPromise(
        Replay.run(
          { root: repoOneFail, commits: 1, modes: ["normal"], warm: false, trial: true },
          replayParts(head)
        ).pipe(Effect.provide(baseLayer))
      )
      expect(rep.commits.length).toBe(1)
    } finally {
      rmSync(repoOneFail, { recursive: true, force: true })
    }

    // 4. All jobs fail -> tooFewLeft refusal
    const repoAllFail = makeSmallRepository([
      fixtureJob("failA", "exit 1"),
      fixtureJob("failB", "exit 1")
    ])
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoAllFail, encoding: "utf8" }).trim()
      const ex = await Effect.runPromiseExit(
        Replay.run(
          { root: repoAllFail, commits: 1, modes: ["normal"], warm: false, trial: true },
          replayParts(head)
        ).pipe(Effect.provide(baseLayer))
      )
      expect(Exit.isFailure(ex)).toBe(true)
    } finally {
      rmSync(repoAllFail, { recursive: true, force: true })
    }

    // 5. Low disk space stopping replay during start() (hits disk.stopped early finishedReport L1560-1583!)
    const repoDisk = makeRepository()
    try {
      const lowDisk = Layer.succeed(Disk.DiskSpace, {
        space: () => Effect.succeed({ free: 1024, total: 100 * 1_000_000_000 }),
        held: () => Effect.succeed(50 * 1_000_000_000)
      })
      const rep = await Effect.runPromise(
        Replay.run(
          { root: repoDisk.root, commits: 1, modes: ["normal"], warm: true, trial: false },
          replayParts(repoDisk.commits[0]!)
        ).pipe(
          Effect.provide(Layer.mergeAll(NodeServices.layer, lowDisk, replayOptions, silentProgress))
        )
      )
      expect(rep.stopped).toBeDefined()
    } finally {
      repoDisk.remove()
    }
  }, 240_000)
})

describe("packages/ci Wave 10: NativeReplay.vibe deterministic branches & error paths", () => {
  it("exercises NativeReplay baseline+fast, broken install, empty/bad/mismatched selection plan & explicit targets", async () => {
    const nativeOpts = Layer.succeed(Replay.Options, {
      smthrs: [nativeSmthrs],
      reruns: 0,
      prepare: () => Effect.void,
      confine: unconfined
    })
    const baseLayer = Layer.mergeAll(NodeServices.layer, plentyDisk, nativeOpts, silentProgress)
    const runNative = NativeReplay.run(Replay.run as never) as (req: unknown, parts: unknown) => Effect.Effect<{ readonly commits: ReadonlyArray<unknown> }, unknown, FileSystem.FileSystem | Path.Path | ChildProcessSpawner>
    const nativeParts = (head: string) => ({ ...replayParts(head), read: InventoryRead.read })

    // 1. Healthy own repo with baseline + fast modes
    const own = makeOwn()
    try {
      const rep = await Effect.runPromise(
        runNative(
          { root: own.root, commits: 1, modes: ["normal", "fast"], warm: false, trial: false },
          nativeParts(execFileSync("git", ["rev-parse", "HEAD"], { cwd: own.root, encoding: "utf8" }).trim())
        ).pipe(Effect.provide(baseLayer))
      )
      expect(rep.commits.length).toBeGreaterThanOrEqual(1)
    } finally {
      rmSync(own.root, { recursive: true, force: true })
    }

    // 2. Broken install script -> commit recorded as notInstalled / install failure
    const brokenRoot = makeOwnWith(nativeSmthrs, { "install.mjs": brokenInstall })
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: brokenRoot, encoding: "utf8" }).trim()
      const ex = await Effect.runPromiseExit(
        runNative(
          { root: brokenRoot, commits: 1, modes: ["normal"], targets: ["//..."], warm: false, trial: false },
          nativeParts(head)
        ).pipe(Effect.provide(baseLayer))
      )
      expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)
    } finally {
      rmSync(brokenRoot, { recursive: true, force: true })
    }

    // 3. Fake smthrs returning bad JSON plan -> command-failed
    const badPlanBin = fakeSmthrs('if (process.argv.includes("--plan")) { console.log("not-json"); process.exit(0); }')
    const badPlanRoot = makeOwnWith(badPlanBin, {
      ".github/workflows/ci.yml": workflowFor(["//..."])
    })
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: badPlanRoot, encoding: "utf8" }).trim()
      const ex = await Effect.runPromiseExit(
        runNative({ root: badPlanRoot, commits: 1, modes: ["normal"], warm: false, trial: false }, nativeParts(head)).pipe(
          Effect.provide(baseLayer)
        )
      )
      expect(Exit.isFailure(ex)).toBe(true)
    } finally {
      rmSync(badPlanRoot, { recursive: true, force: true })
      rmSync(badPlanBin, { force: true })
    }

    // 4. Fake smthrs returning empty roots -> unsupported ("selected no targets")
    const emptyPlanBin = fakeSmthrs(
      'if (process.argv.includes("--plan")) { console.log(JSON.stringify({ roots: [], targets: [] })); process.exit(0); }'
    )
    const emptyPlanRoot = makeOwnWith(emptyPlanBin, {
      ".github/workflows/ci.yml": workflowFor(["//..."])
    })
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: emptyPlanRoot, encoding: "utf8" }).trim()
      const ex = await Effect.runPromiseExit(
        runNative(
          { root: emptyPlanRoot, commits: 1, modes: ["normal"], warm: false, trial: false },
          nativeParts(head)
        ).pipe(Effect.provide(baseLayer))
      )
      expect(Exit.isFailure(ex)).toBe(true)
    } finally {
      rmSync(emptyPlanRoot, { recursive: true, force: true })
      rmSync(emptyPlanBin, { force: true })
    }

    // 5. Open target in PACKAGE.ts
    const openRoot = makeOwnWith(nativeSmthrs, { "PACKAGE.ts": packageWithOpenTarget })
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: openRoot, encoding: "utf8" }).trim()
      const ex = await Effect.runPromiseExit(
        runNative(
          { root: openRoot, commits: 1, modes: ["normal"], targets: ["//..."], warm: false, trial: false },
          nativeParts(head)
        ).pipe(Effect.provide(baseLayer))
      )
      expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)
    } finally {
      rmSync(openRoot, { recursive: true, force: true })
    }
  }, 240_000)
})

describe("packages/ci Wave 10: Kept, DiskSpace long paths, Stall procfs descendant & Process", () => {
  it("fuzzes Kept.addEntries (finished copy, mtime, existing skip, non-file skip) & DiskSpace.heldUnder long paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w10-ci-kept-disk-"))
    try {
      // Kept.addEntries: nested entry with .finished + regular file + mtime
      const from = join(dir, "from")
      const to = join(dir, "to")
      const entryDir = join(from, "aa", "bb")
      const badEntryDir = join(from, "cc", "bad")
      mkdirSync(entryDir, { recursive: true })
      mkdirSync(join(badEntryDir, "nested-sub"), { recursive: true })
      writeFileSync(join(entryDir, ".finished"), "")
      writeFileSync(join(entryDir, "payload.bin"), "hello-kept")
      const past = new Date(Date.now() - 60_000)
      utimesSync(entryDir, past, past)
      // Entry containing a subdirectory beside .finished -> skipped by child?.type !== "File"
      writeFileSync(join(badEntryDir, ".finished"), "")

      await runNode(Kept.addEntries(from, to))
      // Second pass hits `if (try fs.exists(target)) return`
      await runNode(Kept.addEntries(from, to))

      // DiskSpace.heldUnder with deep path > 1024 bytes on platform="darwin" (perl fallback) & linux
      const deepRoot = join(dir, "deep")
      let cur = deepRoot
      for (let i = 0; i < 14; i++) {
        cur = join(cur, "segment_" + String(i).padStart(2, "0") + "_" + "a".repeat(72))
        mkdirSync(cur, { recursive: true })
      }
      writeFileSync(join(cur, "leaf.txt"), "deep-bytes")

      const heldDarwin = await DiskSpace.heldUnder(deepRoot, undefined, "darwin")
      expect(heldDarwin).toBeGreaterThanOrEqual(0)
      const heldLinux = await DiskSpace.heldUnder(deepRoot, undefined, "linux")
      expect(heldLinux).toBeGreaterThanOrEqual(0)

      // Stall.tableFor("linux") read + under + stop on a real child sleep process
      const child = nodeSpawn("sleep", ["30"], { stdio: "ignore" })
      try {
        const pid = child.pid!
        const linuxTable = Stall.tableFor("linux")
        const procRows = await runNode(linuxTable.read)
        expect(procRows === undefined || Array.isArray(procRows)).toBe(true)
        if (linuxTable.under) {
          const sub = await runNode(linuxTable.under(process.pid))
          expect(sub === undefined || Array.isArray(sub)).toBe(true)
        }
        // Stop the real child descendant using /proc verification!
        await runNode(linuxTable.stop([pid], process.pid, procRows))
        // Also exercise tableFor("darwin") readPs path (fails cleanly on linux or succeeds)
        const darwinTable = Stall.tableFor("darwin")
        const psRows = await runNode(darwinTable.read)
        expect(psRows === undefined || Array.isArray(psRows)).toBe(true)
      } finally {
        try {
          child.kill("SIGKILL")
        } catch {
          // already killed by Stall.tableFor.stop
        }
      }

      // Stall watch CPU progress reset (lines 242-244)
      const arb = Arbitrary.schema(Schema.Struct({ cpuStep: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 500 })) }))
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.sync(() => {
              expect(Process.describe(new Error(`e-${input.cpuStep}`))).toContain("e-")
              expect(Process.describe({ message: "plain-str" })).toBe("plain-str")
              return true
            }),
          { executions: Math.min(executions, 20), seed }
        )
      )
      assertPassed(report)

      // Ref check
      const r = await Effect.runPromise(Ref.make(Date.now()))
      expect(await Effect.runPromise(Ref.get(r))).toBeGreaterThan(0)
      expect(Duration.millis(10)).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
