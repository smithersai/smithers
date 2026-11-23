import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { ci as ciOf, type Job } from "../src/contract/Inventory.vibe"
import type { TargetResult } from "../src/contract/RunRecord.vibe"
import type { TargetMap } from "../src/contract/TargetMap.vibe"
import * as Asked from "../src/replay/Asked.vibe"
import * as Confine from "../src/replay/Confine.vibe"
import * as CpuWatch from "../src/replay/CpuWatch.vibe"
import * as Disk from "../src/replay/Disk.vibe"
import * as History from "../src/replay/History.vibe"
import * as Jail from "../src/replay/Jail.ts"
import * as JobMod from "../src/replay/Job.vibe"
import * as Kept from "../src/replay/Kept.vibe"
import * as Replay from "../src/replay/Replay.vibe"
import * as Stall from "../src/replay/Stall.vibe"
import * as Summary from "../src/replay/Summary.vibe"
import { makeRepository } from "./replay/fixture.ts"
import { makePlace, unconfined } from "./replay/place.ts"
import { options, parts } from "./replay/TestParts.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261126")

const makeJob = (id: string, extra: Partial<Job> = {}): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  runsOn: "ubuntu-latest",
  steps: [{ id: `${id}:1`, command: "true", cwd: "", env: {}, secrets: [] }],
  unsupported: [],
  ...extra
})

describe("@smthrs/ci replay deep fuzz invariants", () => {
  it("Summary functions handle arbitrary replayable inventories, failures, reruns, trials, stations & reports", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        host: Schema.Literals(["linux", "darwin", "win32"]),
        failCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4 }))),
        rerunIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
        remote: Schema.Literals([
          "https://user:secret@github.com/acme/repo.git",
          "https://github.com/acme/repo.git",
          "git@github.com:acme/repo.git",
          "/local/repo"
        ]),
        errorOutput: Schema.Literals([
          "//:a FAIL exit code 1\nboom error line\n",
          '{"code":"ci_failed","message":"target failed"}\n',
          "plain failure\n",
          ""
        ]),
        could: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ host, failCount, rerunIdx, remote, errorOutput, could }) =>
          Effect.sync(() => {
            const inv = ciOf({
              version: 1,
              repository: "acme/repo",
              commit: "a".repeat(40),
              toolchains: [],
              jobs: [
                makeJob("ci.yml:a"),
                makeJob("ci.yml:b", { needs: ["ci.yml:a"] }),
                makeJob("ci.yml:win", { runsOn: "windows-latest" }),
                makeJob("ci.yml:sched", { triggers: ["schedule"] })
              ]
            })
            const map: TargetMap = {
              version: 1,
              targets: [
                { label: "//:a", job: "ci.yml:a", step: "ci.yml:a:1", variant: {} },
                { label: "//:b", job: "ci.yml:b", step: "ci.yml:b:1", variant: {} }
              ]
            }
            const rep = Summary.replayable(inv, map, host)
            const texts = Summary.failureTexts(errorOutput)
            Summary.seenIn(errorOutput, ["//:a", "//:b"])
            Summary.failsApplied(["//:a"])
            Summary.failure("command-failed", "boom")
            Summary.stepKey("ci.yml:a:1", { os: "linux" })
            Summary.exitAndError({ exitCode: 1, reason: "boom" })
            Summary.failedStep({ step: "ci.yml:a:1", exitCode: 1, reason: "boom" })
            Summary.tooFewLeft(could, rep.left)
            Summary.ranAgainAt(rerunIdx, "aaa", "bbb")
            const results: Array<TargetResult> = [
              { label: "//:a", status: failCount > 0 ? "failed" : "ran", key: "k1", durationMs: 10 },
              { label: "//:b", status: failCount > 1 ? "failed" : "hit", key: "k2", durationMs: 5 }
            ]
            Summary.failedTwice(results)
            Summary.rightsTaken(["sudo", "apt"])
            Summary.rightsOf(rep.units, [{ label: "//:a", status: "failed", key: "k1", durationMs: 10, rights: ["sudo"] }])
            Summary.leftForRights([{ job: "ci.yml:a", programs: ["sudo"] }])
            Summary.noCommitBefore("abc1234")
            Summary.noCiBefore("abc1234")
            Summary.jobsCovered(rep.units, rep.left)
            if (rep.units[0] !== undefined) {
              Summary.unitKey(rep.units[0])
              Summary.labelsOf(rep.units[0], new Set(["//:a"]))
              Summary.targetsOf(rep.units)
              Summary.splitOf(rep.units)
              Summary.stepNames(rep.units)
              Summary.stationsOf(rep.units, undefined)
            }
            Summary.nothingToReplay(rep.left)
            const cleaned = Summary.withoutCredentials(remote)
            const pub = Summary.publicRemote(remote)
            Summary.failedAt({ job: "ci.yml:a", reason: "err" }, ["c1", "c2"])
            Summary.trialOf(rep.units, results, Summary.stepNames(rep.units))

            // Asked helpers
            const askText = Asked.asking(inv, ["ci.yml:a", "ci.yml:missing"])
            const noneText = Asked.noneAsked(["ci.yml:missing"])
            const toRep = Asked.toReplay(inv, ["ci.yml:a"])

            return (
              texts instanceof Map &&
              !cleaned.includes("secret") &&
              typeof pub === "string" &&
              askText !== undefined &&
              typeof noneText === "string" &&
              toRep !== undefined
            )
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Jail, Disk, History, Stall, CpuWatch, Kept, Job & Confine helpers satisfy pure & temp-dir invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        totalBytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1_000_000, maximum: 500_000_000_000 }))),
        freeBytes: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 50_000_000_000 }))),
        allowDocker: Schema.Boolean,
        count: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
        hasEnv: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ totalBytes, freeBytes, allowDocker, count, hasEnv }) =>
          Effect.sync(() => {
            // Disk pure helpers
            const floor = Disk.floorOf(totalBytes)
            const stop = Disk.stoppedLine("/tmp/work", freeBytes, floor, 1024, count)
            const wait = Disk.waitingLine(freeBytes, floor)

            // History pure helpers
            const f1 = History.fetching(count, "origin")
            const f2 = History.cannotFetch(count, "origin", "timeout")
            const f3 = History.noRemote(count, "origin")
            const f4 = History.shallow(count, count + 5, 5)

            // Jail pure helpers
            const sockets = Jail.daemonSockets(1000, { XDG_RUNTIME_DIR: "/run/user/1000", DOCKER_HOST: allowDocker ? "unix:///tmp/docker.sock" : undefined })
            const probeEnv = hasEnv ? { PATH: process.env["PATH"], HOME: "/tmp" } : {}
            const probed = Jail.probeWith(probeEnv)
            const filter = Jail.keyringFilter()
            const temps = Jail.temporaryOf("/tmp/custom")
            const unj = Jail.unjailed("no bwrap", allowDocker)
            const inst = Jail.installOf("/usr/local/bin/node", (d) => d === "/usr/local")
            const caches = Replay.compiledCaches("/tmp/cache", !allowDocker)
            const stopped = Replay.ownStop(Cause.die(new Error("boom")))
            const notStopped = Replay.ownStop(Cause.fail("expected"))

            return (
              floor >= Disk.floorBytes &&
              stop.length > 0 &&
              wait.length > 0 &&
              f1.length > 0 &&
              f2.length > 0 &&
              f3.length > 0 &&
              f4.length > 0 &&
              Array.isArray(sockets) &&
              typeof probed === "object" &&
              filter instanceof Uint8Array &&
              temps.includes("/tmp") &&
              unj.length > 0 &&
              typeof inst === "string" &&
              typeof caches["NODE_COMPILE_CACHE"] === "string" &&
              stopped !== undefined &&
              notStopped === undefined
            )
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Confine, Kept, Job, Disk.diskWatch, Stall & CpuWatch operate cleanly on temporary directories", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        fileCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
        lowSpace: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ fileCount, lowSpace }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem
              const path = yield* Path.Path
              const work = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-ci-confine-fuzz-" })

              // Confine helpers
              const places = yield* Confine.confine(work, unconfined, () => Effect.void, [], false)
              const held = Confine.held(places.normal, [path.join(work, "copy")], ["echo", "hi"])
              const homes = Confine.jobHomes(places.normal)
              yield* Confine.renew(places.normal)
              const freshDir = path.join(work, "fresh-dir")
              yield* Confine.fresh(freshDir)
              yield* fs.writeFileString(path.join(freshDir, "a.txt"), "hello")
              yield* Confine.discard(freshDir)

              // Kept snapshot / viewOf / keep / backTo
              const srcDir = path.join(work, "kept-src")
              const storeDir = path.join(work, "kept-store")
              const viewDir = path.join(work, "kept-view")
              const backupDir = path.join(work, "kept-backup")
              yield* fs.makeDirectory(srcDir, { recursive: true })
              for (let i = 0; i < fileCount; i++) {
                yield* fs.writeFileString(path.join(srcDir, `f${i}.txt`), `val-${i}`)
              }
              yield* Kept.addEntries(srcDir, storeDir)
              yield* Kept.viewOf(storeDir, [], viewDir)
              yield* Kept.keep([viewDir], storeDir)
              yield* Kept.snapshot(srcDir, backupDir)
              yield* Kept.backTo(srcDir, backupDir)

              // Job helpers
              const reaper = yield* JobMod.reaperIn(places.normal)
              const before = yield* JobMod.processesBefore(undefined, reaper)
              yield* JobMod.endLeftIn(before, work)

              // DiskWatch with synthetic DiskSpace service
              const spaceLayer = Layer.succeed(Disk.DiskSpace, {
                space: () => Effect.succeed({ free: lowSpace ? 1024 : 50 * 1024 ** 3, total: 100 * 1024 ** 3 }),
                held: () => Effect.succeed(1024)
              })
              const dw = yield* Disk.diskWatch(work, work, () => Effect.void, "20 millis").pipe(Effect.provide(spaceLayer))
              yield* Effect.exit(dw.admit(Effect.void))
              yield* dw.release

              // Stall watch & touching stream
              const table = Stall.tableFor(process.platform)
              const watch = yield* Stall.watchFor(1, table)
              const chunks = yield* Stream.runCollect(
                Stall.touching(Stream.make(new TextEncoder().encode("hi")), watch)
              )

              // CpuWatch with fast tick
              const cw = yield* CpuWatch.cpuWatch(table, "50 millis")
              const stopTrack = cw.track(process.pid)
              stopTrack()

              // makePlace sanity
              const p = makePlace()
              yield* fs.remove(path.dirname(path.dirname(p.home)), { recursive: true }).pipe(Effect.ignore)

              return (
                typeof held === "object" &&
                typeof homes === "object" &&
                chunks.length === 1
              )
            })
          ).pipe(Effect.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  Layer.succeed(Disk.DiskSpace, {
                    space: () => Effect.succeed({ total: 200 * 1_000_000_000, free: 100 * 1_000_000_000 }),
                    held: () => Effect.succeed(0),
                  }),
                ),
              )),
        { seed, executions: Math.min(executions, 6) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Replay.run replays real multi-commit histories across normal, fast, trial & warm configurations", async () => {
    const repo = makeRepository()
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          commits: Schema.Literals([2]),
          includeFast: Schema.Literals([true]),
          trial: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ commits, includeFast, trial }) =>
            Effect.gen(function* () {
              const res = yield* Replay.run(
                {
                  root: repo.root,
                  commits,
                  modes: includeFast ? ["normal", "fast"] : ["normal"],
                  jobs: 2,
                  trial,
                  settings: { scoreCutoff: 0.5, countCutoff: 0 }
                },
                parts(repo.commits[0]!)
              )
              return res.commits.length === commits && res.repository === "test/replay"
            }).pipe(Effect.provide(Layer.mergeAll(options, NodeServices.layer, Layer.succeed(Disk.DiskSpace, {
                space: () => Effect.succeed({ total: 200 * 1_000_000_000, free: 100 * 1_000_000_000 }),
                held: () => Effect.succeed(0),
              })))),
          { seed, executions: 1 }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    } finally {
      repo.remove()
    }
  }, 180_000)
})
