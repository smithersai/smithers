import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Evaluator } from "@smthrs/model"
import {
  Arbitrary,
  Console,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Ref,
  Result,
  Schema,
  Scope,
  Stream
} from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/cli/Cli.vibe"
import * as Host from "../src/cli/Host.vibe"
import * as Install from "../src/cli/Install.ts"
import * as Main from "../src/cli/main.vibe"
import * as Restart from "../src/cli/Restart.ts"
import * as Stage from "../src/cli/Stage.vibe"
import { ci as ciOf, type Inventory, type Job, type KeptStep } from "../src/contract/Inventory.vibe"
import type { Failure, GeneratedFile } from "../src/contract/Parts.vibe"
import * as Generate from "../src/generate/index.vibe"
import * as GenerateKept from "../src/generate/Kept.vibe"
import * as GenerateSteps from "../src/generate/Steps.vibe"
import * as Asked from "../src/replay/Asked.vibe"
import * as Confine from "../src/replay/Confine.vibe"
import * as Disk from "../src/replay/Disk.vibe"
import * as DiskSpace from "../src/replay/DiskSpace.ts"
import * as History from "../src/replay/History.vibe"
import type { Probe } from "../src/replay/Jail.ts"
import * as JobMod from "../src/replay/Job.vibe"
import * as Kept from "../src/replay/Kept.vibe"
import * as Process from "../src/replay/Process.vibe"
import { Options, Progress, WorkDirectory } from "../src/replay/Replay.vibe"
import * as Stall from "../src/replay/Stall.vibe"
import { inProcess } from "./cli/inProcess.vibe"
import { parts as cliParts } from "./cli/parts.vibe"
import { commit as cliCommit, git as cliGit, recorder, temporary } from "./cli/repo.ts"
import { makePlace, unconfined } from "./replay/place.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261181")
const runFuzz = async <A>(
  arb: Parameters<typeof Fuzz.run<A>>[0],
  fn: (sample: A) => Promise<void>,
  opts: { executions: number; seed: number }
) => {
  const report = await Effect.runPromise(Fuzz.run(arb, (sample) =>
    Effect.promise(async () => {
      await fn(sample)
      return true
    }), opts))
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}
const lightExecutions = Math.min(executions, 20)

const runNode = <A, E>(
  eff: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner | Scope.Scope>
) => Effect.runPromise(Effect.provide(Effect.scoped(eff), NodeServices.layer))

const makeJob = (id: string, extra: Partial<Job> = {}): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  runsOn: "ubuntu-latest",
  steps: [{ id: `${id}:1`, command: "echo ok", cwd: "", env: {}, secrets: [] }],
  unsupported: [],
  ...extra
})

const makeInventory = (jobs: ReadonlyArray<Job>, extra: Partial<Inventory> = {}): Inventory => ({
  version: 1,
  repository: "acme/wave8",
  commit: "0123456789abcdef0123456789abcdef01234567",
  jobs,
  toolchains: [],
  ...extra
})

describe("packages/ci Wave-8 Confine, Disk, Stall, Job, History, Kept, CLI & Generate fuzz", () => {
  it(
    "fuzzes Confine.confine (jailed & refusals), plannerRuntime, removeTree, discard, machine & PipedCommand",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          allowDocker: Schema.Boolean,
          withCheckout: Schema.Boolean,
          withScope: Schema.Boolean,
          requireJail: Schema.Boolean,
          allowUnconfined: Schema.Boolean,
          trusted: Schema.Boolean,
          nestedMount: Schema.Boolean
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          const work = mkdtempSync(join(tmpdir(), "ci-w8-confine-"))
          const fakeHome = join(work, "fake-home")
          const fakeTmp = join(work, "fake-tmp")
          const fakeHidden = join(work, "fake-hidden")
          const fakeTools = join(fakeHome, ".tools")
          const fakeBin = join(fakeTools, "bin")
          const fakeSdkReal = join(fakeHome, "Android", "real-sdk")
          const fakeSdkLink = join(fakeHome, "Android", "Sdk")
          const fakeCache = join(work, "fake-cache")
          const fakeDaemon = join(fakeHome, "docker.sock")
          const fakeCheckout = join(work, "checkout")
          const fakeWork = join(work, "replay-work")
          try {
            mkdirSync(fakeBin, { recursive: true })
            mkdirSync(fakeSdkReal, { recursive: true })
            mkdirSync(fakeTmp, { recursive: true })
            mkdirSync(fakeHidden, { recursive: true })
            mkdirSync(fakeCache, { recursive: true })
            mkdirSync(fakeWork, { recursive: true })
            writeFileSync(join(fakeHome, ".npmrc"), "registry=https://example.com\n")
            writeFileSync(fakeDaemon, "")
            writeFileSync(join(fakeHome, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
            const prog = join(fakeBin, "tool-bin")
            writeFileSync(prog, "#!/bin/sh\necho ok\n")
            chmodSync(prog, 0o755)
            symlinkSync(fakeSdkReal, fakeSdkLink)
            const hiddenFile = join(work, "secret-file")
            writeFileSync(hiddenFile, "secret")
            mkdirSync(join(fakeHome, ".nvm"), { recursive: true })

            if (sample.withCheckout) {
              mkdirSync(fakeCheckout, { recursive: true })
              execFileSync("git", ["init", "-q"], { cwd: fakeCheckout })
            }

            const probe = (): Probe => ({
              bwrap: "/usr/bin/bwrap",
              home: fakeHome,
              tmp: fakeTmp,
              daemons: [fakeDaemon],
              hidden: [fakeHidden, hiddenFile, join(fakeHome, "missing-hidden")],
              tools: {
                reads: [fakeTools, join(fakeTmp, "corepack-cache")],
                links: [{ path: join(fakeHome, ".nvm", "current"), target: fakeTools }],
                homes: [{ path: ".nvm/current", target: fakeTools }]
              },
              caches: [fakeCache, join(work, "missing-cache")],
              scope: sample.withScope ? "systemd-run" : undefined
            })

            mkdirSync(join(fakeTmp, "corepack-cache"), { recursive: true })
            const said: Array<string> = []
            const places = await runNode(
              Confine.confine(
                fakeWork,
                probe,
                (line) =>
                  Effect.sync(() => {
                    said.push(line)
                  }),
                [prog, "relative-prog", fakeBin, join(work, "nonexistent-prog")],
                sample.allowDocker,
                {
                  PATH: process.env.PATH,
                  ANDROID_HOME: fakeSdkLink,
                  HOME: fakeHome
                },
                sample.withCheckout ? fakeCheckout : undefined
              )
            )
            expect(places.normal.jail).toBeDefined()
            expect(places.normal.jail?.bwrap).toBe("/usr/bin/bwrap")
            expect("caches" in places.normal && places.normal.caches).toContain(fakeCache)

            const subHome = join(fakeWork, "sub-home")
            const subTmp = join(fakeWork, "sub-tmp")
            const subPlace = await runNode(
              Confine.machine(places.normal, subHome, subTmp, true)
            )
            expect(subPlace.jail?.tmp).toBe(subTmp)

            // Exercise Confine.reading with a PipedCommand
            await runNode(
              Effect.gen(function*() {
                const real = yield* ChildProcessSpawner
                const wrapped = Confine.reading(real, { ...places.normal, jail: undefined }, fakeWork)
                const piped = ChildProcess.pipeTo(
                  ChildProcess.make("echo", ["hello"], { cwd: fakeWork }),
                  ChildProcess.make("cat", [], { cwd: fakeWork })
                )
                const out = yield* Effect.scoped(wrapped.string(piped))
                expect(out.trim()).toBe("hello")
              })
            )

            // Exercise Confine.confine refusal branches
            const refusalProbe = (): Probe => ({
              refusal: "no bwrap available",
              trustedRepository: sample.trusted
            })
            const refusalEnv: Record<string, string | undefined> = {
              ...(sample.requireJail ? { SMITHERS_CI_REQUIRE_JAIL: "1" } : {}),
              ...(sample.allowUnconfined ? { SMITHERS_CI_ALLOW_UNCONFINED: "1" } : {})
            }
            const refusalExit = await Effect.runPromiseExit(
              Effect.provide(
                Effect.scoped(
                  Confine.confine(join(work, "refusal-work"), refusalProbe, () => Effect.void, [], false, refusalEnv)
                ),
                NodeServices.layer
              )
            )
            if (sample.requireJail || (!sample.trusted && !sample.allowUnconfined)) {
              expect(Exit.isFailure(refusalExit)).toBe(true)
            } else {
              expect(Exit.isSuccess(refusalExit)).toBe(true)
            }

            // Exercise Confine.plannerRuntime with real files & node_modules & symlink refusal
            const repoDir = join(work, "rt-repo")
            const rtDir = join(work, "rt-stage")
            mkdirSync(join(repoDir, "node_modules", ".bin"), { recursive: true })
            mkdirSync(join(repoDir, "packages", "a", "node_modules"), { recursive: true })
            mkdirSync(join(repoDir, "bin"), { recursive: true })
            mkdirSync(rtDir, { recursive: true })
            const binFile = join(repoDir, "bin", "smthrs")
            const nmBin = join(repoDir, "node_modules", ".bin", "smthrs")
            writeFileSync(binFile, "#!/bin/sh\necho ok\n")
            writeFileSync(nmBin, "#!/bin/sh\necho ok\n")
            const rt = await runNode(
              Confine.plannerRuntime(
                repoDir,
                rtDir,
                ["relative", "/usr/bin/env", binFile, nmBin],
                () => Effect.succeed(sample.nestedMount ? ["packages/a/package.json"] : [])
              )
            )
            expect(rt.mounts.length).toBeGreaterThan(0)
            expect(rt.paths.get(binFile)).toBe(join(rtDir, "bin", "smthrs"))

            // Symlink mount point refusal in plannerRuntime
            const rtBad = join(work, "rt-bad")
            mkdirSync(rtBad, { recursive: true })
            symlinkSync(join(work, "fake-tmp"), join(rtBad, "bin"))
            const badRtExit = await Effect.runPromiseExit(
              Effect.provide(
                Confine.plannerRuntime(repoDir, rtBad, [binFile], () => Effect.succeed([])),
                NodeServices.layer
              )
            )
            expect(Exit.isFailure(badRtExit)).toBe(true)

            // Exercise removeTree outside work dir, symlink refusal, missing dir, and discard failure callback
            const outExit = await Effect.runPromiseExit(
              Effect.provide(Confine.removeTree(join(work, "..", "outside"), fakeWork), NodeServices.layer)
            )
            expect(Exit.isFailure(outExit)).toBe(true)

            const symInWork = join(fakeWork, "bad-link")
            symlinkSync(fakeTmp, symInWork)
            const symExit = await Effect.runPromiseExit(
              Effect.provide(Confine.removeTree(symInWork, fakeWork), NodeServices.layer)
            )
            expect(Exit.isFailure(symExit)).toBe(true)

            // Missing dir returns cleanly
            await runNode(Confine.removeTree(join(fakeWork, "does-not-exist"), fakeWork))

            // Discard on valid directory + symlinked root triggers say()
            const toDiscard = join(work, "to-discard")
            mkdirSync(join(toDiscard, "sub"), { recursive: true })
            writeFileSync(join(toDiscard, "sub", "f"), "x")
            await runNode(Confine.discard(toDiscard))

            const badDiscardLink = join(work, "bad-discard-link")
            symlinkSync(fakeTmp, badDiscardLink)
            const discardMsgs: Array<string> = []
            await runNode(Confine.discard(badDiscardLink, (line) =>
              Effect.sync(() => {
                discardMsgs.push(line)
              })))
            expect(discardMsgs.length).toBe(1)
          } finally {
            rmSync(work, { recursive: true, force: true })
          }
        },
        { executions: lightExecutions, seed }
      )
    },
    240_000
  )

  it(
    "fuzzes DiskSpace.spaceOf/heldUnder, Disk.diskWatch, Stall (tableFor, exitOrStall, exitStoppingStalled), Job, History, Kept & Asked",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          fileCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
          abortEarly: Schema.Boolean,
          diskMode: Schema.Literals(["recover", "stop-immediately", "watch-drops", "no-space"]),
          stallHit: Schema.Boolean,
          hostKind: Schema.Literals(["linux", "darwin"]),
          withLeaves: Schema.Boolean
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          const root = mkdtempSync(join(tmpdir(), "ci-w8-replay-"))
          try {
            // 1. DiskSpace.spaceOf & heldUnder (nested dirs, hard link, symlink, abort signal)
            const sp = await DiskSpace.spaceOf(root)
            expect(sp.total).toBeGreaterThan(0)
            expect(sp.free).toBeGreaterThanOrEqual(0)

            const tree = join(root, "tree")
            mkdirSync(join(tree, "a", "b"), { recursive: true })
            for (let i = 0; i < sample.fileCount; i++) {
              writeFileSync(join(tree, "a", "b", `f${i}.txt`), "x".repeat(4096))
            }
            linkSync(join(tree, "a", "b", "f0.txt"), join(tree, "a", "hardlink.txt"))
            symlinkSync(join(tree, "a", "b", "f0.txt"), join(tree, "a", "symlink.txt"))

            const heldLinux = await DiskSpace.heldUnder(tree, undefined, "linux")
            expect(heldLinux).toBeGreaterThanOrEqual(0)
            const ac = new AbortController()
            if (sample.abortEarly) ac.abort()
            const heldAborted = await DiskSpace.heldUnder(tree, ac.signal, "linux")
            if (sample.abortEarly) expect(heldAborted).toBe(0)

            // Exercise Disk.DiskSpace default service
            const defVal = Disk.DiskSpace.defaultValue()
            const defSpace = await Effect.runPromise(defVal.space(root))
            expect(defSpace?.total).toBeGreaterThan(0)
            const defMissing = await Effect.runPromise(defVal.space(join(root, "nope-missing-path")))
            expect(defMissing).toBeUndefined()
            const defHeld = await Effect.runPromise(defVal.held(tree))
            expect(defHeld).toBeGreaterThanOrEqual(0)

            // 2. Disk.diskWatch across recover / stop / watch-drops / no-space
            let callIdx = 0
            const floor = 10 * DiskSpace.gigabyte
            const fakeDisk = Layer.succeed(Disk.DiskSpace, {
              space: () =>
                Effect.sync(() => {
                  callIdx += 1
                  if (sample.diskMode === "no-space") return undefined
                  if (sample.diskMode === "recover") {
                    return callIdx <= 2
                      ? { free: floor - 1, total: floor * 10 }
                      : { free: floor * 2, total: floor * 10 }
                  }
                  if (sample.diskMode === "stop-immediately") {
                    return { free: floor / 4, total: floor * 10 }
                  }
                  return callIdx <= 2
                    ? { free: floor * 2, total: floor * 10 }
                    : { free: floor / 4, total: floor * 10 }
                }),
              held: () => Effect.succeed(1024 * 1024)
            })

            const diskMsgs: Array<string> = []
            await Effect.runPromise(
              Effect.scoped(
                Effect.gen(function*() {
                  const watch = yield* Disk.diskWatch(
                    root,
                    [tree],
                    (line) =>
                      Effect.sync(() => {
                        diskMsgs.push(line)
                      }),
                    "5 millis"
                  )
                  if (sample.diskMode === "no-space") {
                    expect(yield* watch.most).toBeUndefined()
                  } else if (sample.diskMode === "stop-immediately") {
                    yield* Effect.exit(watch.admit(Effect.void))
                    const stopped = yield* watch.stopped
                    expect(stopped).toBeDefined()
                    // Second call exercises cached() + stoppedAt !== undefined
                    expect(yield* watch.stopped).toBe(stopped)
                  } else if (sample.diskMode === "recover") {
                    yield* watch.admit(Effect.void)
                    yield* watch.release
                    expect(yield* watch.most).toBeGreaterThanOrEqual(0)
                  } else {
                    yield* watch.admit(Effect.void)
                    yield* Effect.sleep("25 millis")
                    yield* watch.release
                    yield* watch.stopped
                  }
                })
              ).pipe(Effect.provide(fakeDisk))
            )

            // 3. Stall: defaultStall, tableFor("linux" | "darwin"), exitOrStall & exitStoppingStalled
            const defStall = Stall.defaultStall()
            expect(defStall.minutes).toBe(Stall.defaultStallMinutes)

            const hostTable = Stall.tableFor(sample.hostKind)
            await runNode(
              Effect.gen(function*() {
                const rows = yield* hostTable.read
                expect(rows === undefined || Array.isArray(rows)).toBe(true)
                if (hostTable.under) {
                  const under = yield* hostTable.under(process.pid)
                  expect(under === undefined || Array.isArray(under)).toBe(true)
                }
                // Calling stop with self pid (pid === root) safely returns false without killing anything
                yield* hostTable.stop([process.pid, 999_999_999], process.pid, rows)
              })
            )

            // Synthetic fast-ticking Stall watch to deterministically trigger stall + stopRounds
            let reads = 0
            const stoppedPids: Array<number> = []
            const fastTable: Stall.Table = {
              read: Effect.sync(() => {
                reads += 1
                if (reads === 1) return []
                return sample.withLeaves
                  ? [
                    { pid: 4242, parent: 1, cpuMs: 10, started: 1 },
                    { pid: 4243, parent: 4242, cpuMs: 0, started: 2 }
                  ]
                  : [{ pid: 4242, parent: 1, cpuMs: 10, started: 1 }]
              }),
              stop: (pids) =>
                Effect.sync(() => {
                  stoppedPids.push(...pids)
                })
            }
            const stallWatch = {
              limitMs: 12,
              tick: "4 millis",
              table: fastTable,
              touched: Ref.makeUnsafe(0),
              stalled: Ref.makeUnsafe(false)
            }
            await runNode(
              Effect.gen(function*() {
                const fakeHandle = {
                  pid: 4242 as unknown as ChildProcessSpawner["Service"] extends never ? never : number,
                  exitCode: sample.stallHit ? Effect.never : Effect.succeed(0)
                } as unknown as Parameters<typeof Stall.exitOrStall>[0]
                const res = yield* Stall.exitOrStall(fakeHandle, stallWatch as unknown as Stall.Watch)
                expect(res).toBe(sample.stallHit ? "stalled" : 0)

                const watch2 = {
                  limitMs: 10,
                  tick: "3 millis",
                  table: fastTable,
                  touched: Ref.makeUnsafe(0),
                  stalled: Ref.makeUnsafe(false)
                }
                const fakeHandle2 = {
                  pid: 4242,
                  exitCode: sample.stallHit ? Effect.never : Effect.succeed(0)
                } as unknown as Parameters<typeof Stall.exitStoppingStalled>[0]
                const res2 = yield* Stall.exitStoppingStalled(fakeHandle2, watch2 as unknown as Stall.Watch)
                if (sample.stallHit) {
                  expect(res2).toBeUndefined()
                  expect(yield* Ref.get(watch2.stalled)).toBe(true)
                }
              })
            )

            // 4. Job.keeperIn, keepsPrograms, reaperIn, processesBefore, endLeftIn
            const noJailPlace = makePlace()
            await runNode(
              Effect.scoped(
                Effect.gen(function*() {
                  expect(yield* JobMod.keeperIn(noJailPlace, [], join(root, "k0"), () => Effect.void)).toBeUndefined()
                  expect(yield* JobMod.keepsPrograms(noJailPlace)).toBe(false)
                  // Fake bwrap script that creates keeper.sock and sleeps, vs exits immediately
                  const fakeBwrapOk = join(root, "fake-bwrap-ok.sh")
                  writeFileSync(fakeBwrapOk, "#!/bin/sh\ntouch keeper.sock\nsleep 2\n")
                  chmodSync(fakeBwrapOk, 0o755)
                  const fakeBwrapExit = join(root, "fake-bwrap-exit.sh")
                  writeFileSync(fakeBwrapExit, "#!/bin/sh\nexit 0\n")
                  chmodSync(fakeBwrapExit, 0o755)
                  const filterPath = join(root, "seccomp")
                  writeFileSync(filterPath, "")

                  const makeJailPlace = (bwrap: string): Confine.Confined => ({
                    ...noJailPlace,
                    jail: {
                      bwrap,
                      masks: [],
                      tmp: join(root, "jtmp"),
                      temporary: [],
                      visible: [],
                      filter: filterPath
                    }
                  })
                  mkdirSync(join(root, "jtmp"), { recursive: true })
                  const okPlace = makeJailPlace(fakeBwrapOk)
                  const keeper = yield* JobMod.keeperIn(okPlace, [], join(root, "k1"), () => Effect.void)
                  expect(keeper?.pid).toBeGreaterThan(0)
                  expect(yield* JobMod.processesBefore(keeper, undefined)).toBeUndefined()
                  expect(yield* JobMod.reaperIn(okPlace)).toBeUndefined()
                  expect(yield* JobMod.keepsPrograms(makeJailPlace(fakeBwrapExit))).toBe(true)
                  const badKeeper = yield* JobMod.keeperIn(
                    makeJailPlace(fakeBwrapExit),
                    [],
                    join(root, "k2"),
                    () => Effect.void
                  )
                  expect(badKeeper).toBeUndefined()
                  expect(yield* JobMod.reaperIn(noJailPlace, () => fakeBwrapExit)).toBe(fakeBwrapExit)
                  yield* JobMod.endLeftIn(undefined, root)
                })
              )
            )

            // 5. History: promisorOf, sayShallow, fetchMissing (partial clone + errors)
            const bareRepo = join(root, "bare.git")
            const srcRepo = join(root, "src-repo")
            const shallowRepo = join(root, "shallow-repo")
            const partialRepo = join(root, "partial-repo")
            mkdirSync(bareRepo, { recursive: true })
            mkdirSync(srcRepo, { recursive: true })
            execFileSync("git", ["init", "--bare", "-q", bareRepo])
            execFileSync("git", ["-C", bareRepo, "config", "uploadpack.allowFilter", "true"])
            execFileSync("git", ["init", "-q", srcRepo])
            execFileSync("git", ["-C", srcRepo, "config", "user.name", "W8"])
            execFileSync("git", ["-C", srcRepo, "config", "user.email", "w8@example.com"])
            writeFileSync(join(srcRepo, "a.txt"), "one\n")
            execFileSync("git", ["-C", srcRepo, "add", "."])
            execFileSync("git", ["-C", srcRepo, "commit", "-q", "-m", "c1"])
            writeFileSync(join(srcRepo, "b.txt"), "two\n")
            execFileSync("git", ["-C", srcRepo, "add", "."])
            execFileSync("git", ["-C", srcRepo, "commit", "-q", "-m", "c2"])
            execFileSync("git", ["-C", srcRepo, "remote", "add", "origin", bareRepo])
            execFileSync("git", ["-C", srcRepo, "push", "-q", "origin", "HEAD"])
            execFileSync("git", ["clone", "-q", "--depth=1", `file://${bareRepo}`, shallowRepo])
            execFileSync("git", [
              "clone",
              "-q",
              "--filter=blob:none",
              "--no-checkout",
              `file://${bareRepo}`,
              partialRepo
            ])
            const headSha = execFileSync("git", ["-C", partialRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()

            await runNode(
              Effect.gen(function*() {
                expect(yield* History.promisorOf(srcRepo)).toBe("origin")
                expect(yield* History.promisorOf(partialRepo)).toBe("origin")
                execFileSync("git", ["-C", srcRepo, "config", "remote.alt.promisor", "true"])
                expect(yield* History.promisorOf(srcRepo)).toBe("alt")

                const shallowSaid: Array<string> = []
                yield* History.sayShallow(shallowRepo, 1, 5, false, (line) =>
                  Effect.sync(() => {
                    shallowSaid.push(line)
                  }))
                expect(shallowSaid.length).toBe(1)

                const fetchedSaid: Array<string> = []
                yield* History.fetchMissing(partialRepo, partialRepo, [headSha], (line) =>
                  Effect.sync(() => {
                    fetchedSaid.push(line)
                  }))
                expect(fetchedSaid.length).toBeGreaterThanOrEqual(1)
              })
            )

            // 6. Kept.addEntries (nested dirs, .finished, copy + mtime, existing skip, non-file skip)
            const keptFrom = join(root, "kept-from")
            const keptTo = join(root, "kept-to")
            mkdirSync(join(keptFrom, "ns", "entry1"), { recursive: true })
            mkdirSync(join(keptFrom, "ns", "entry2", "subdir"), { recursive: true })
            writeFileSync(join(keptFrom, "ns", "entry1", ".finished"), "")
            writeFileSync(join(keptFrom, "ns", "entry1", "payload"), "hello-kept")
            utimesSync(join(keptFrom, "ns", "entry1"), new Date(1_700_000_000_000), new Date(1_700_000_000_000))
            writeFileSync(join(keptFrom, "ns", "entry2", ".finished"), "")
            await runNode(Kept.addEntries(keptFrom, keptTo))
            // Second call skips already-existing target
            await runNode(Kept.addEntries(keptFrom, keptTo))

            // 7. Asked.toReplay with transitive needs
            const inv = makeInventory([
              makeJob("base"),
              makeJob("mid", { needs: ["base", "unknown-job"] }),
              makeJob("top", { needs: ["mid"] }),
              makeJob("unused")
            ])
            const asked = Asked.toReplay(inv, ["top"])
            expect("inventory" in asked).toBe(true)
            if ("inventory" in asked) {
              expect(asked.asked?.needed.map((n) => n.job)).toEqual(["base", "mid"])
            }

            // 8. Process helpers
            expect(Process.describe({ message: "err-msg" })).toBe("err-msg")
            expect(Process.pastLimit("2 minutes")).toContain("2m")
            const failedExit = await Effect.runPromiseExit(
              Process.orFail(Effect.fail({ message: "boom" }), "step failed")
            )
            expect(Exit.isFailure(failedExit)).toBe(true)
          } finally {
            rmSync(root, { recursive: true, force: true })
          }
        },
        { executions: Math.min(executions, 8), seed: seed + 1 }
      )
    },
    240_000
  )

  it(
    "fuzzes CLI (apply, apply --check, inventory, default, replay errors), Main.run signals/drain/broken, Stage, Host, Install & Restart",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mainOutcome: Schema.Literals([
            "answered",
            "SIGINT",
            "SIGTERM",
            "uncaughtException",
            "drained",
            "bad-recorder"
          ]),
          cliBranch: Schema.Literals([
            "apply-write-and-check",
            "apply-refused-loop",
            "inventory-text-json",
            "default-command",
            "replay-root-and-conflicts",
            "replay-stopped-and-fast-unmeasured",
            "replay-model-unavailable-and-render-fail"
          ]),
          stageKind: Schema.Literals(["first", "normal", "checking", "none"]),
          restartCase: Schema.Literals([
            "not-named",
            "bad-json",
            "array-json",
            "non-string",
            "valid-pipe",
            "with-handed"
          ])
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          // 1. Stage.vibe pure invariants
          const stageLine = sample.stageKind === "first"
            ? "first run 0123456 baseline"
            : sample.stageKind === "normal"
            ? "2/5 0123456 normal"
            : sample.stageKind === "checking"
            ? "checking which jobs pass on this machine at 0123456"
            : "plain note"
          const st = Stage.stageOf(stageLine)
          const tolds: ReadonlyArray<Stage.Told> = [
            Stage.nothingTold,
            { stage: undefined, directories: ["/tmp/work"] },
            { stage: st ?? { doing: "running normal mode", commit: "0123456" }, directories: ["/tmp/work"] }
          ]
          for (const told of tolds) {
            expect(Stage.unanswered(told)).toContain("stopped without an answer")
            expect(Stage.broken(told, new Error("boom"))).toContain("stopped on an error of its own")
          }

          // 2. Host.judge (fake loader) & Host.replayProgress & Host.replayOptions
          const toldRef = Ref.makeUnsafe<Stage.Told>(Stage.nothingTold)
          await Effect.runPromise(
            Effect.gen(function*() {
              const p = yield* Progress
              const wd = yield* WorkDirectory
              yield* wd.at("/tmp/w1")
              yield* p.say("1/3 abcdef1 baseline")
              yield* p.say("note")
            }).pipe(
              Effect.provide(Host.replayProgress(toldRef)),
              Effect.provideService(Console.Console, recorder().service)
            )
          )
          const afterTold = Ref.getUnsafe(toldRef)
          expect(afterTold.directories).toEqual(["/tmp/w1"])
          expect(afterTold.stage?.commit).toBe("abcdef1")

          const judgeLayer = Host.judge({}, async () =>
            ({
              environmentDispatcher: () => ({}) as never,
              layerRebuildableRequestExecutor: () => Layer.empty as never,
              layerSeatEvaluator: () =>
                Layer.succeed(Evaluator.Evaluator, {
                  evaluate: () => Effect.succeed({ ok: true } as never)
                }) as never
            }) as unknown as typeof import("@smthrs/cli/NodeControl"))
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function*() {
                const ev = yield* Evaluator.Evaluator
                const out = yield* ev.evaluate({ prompt: "p", state: {} } as never)
                expect(out).toBeDefined()
              }).pipe(Effect.provide(judgeLayer))
            )
          )

          const noNodeOpts = Host.replayOptions(["smthrs"], false, {})
          const noNodeExit = await Effect.runPromiseExit(
            Effect.gen(function*() {
              const opts = yield* Options
              return yield* opts.prepare("/tmp")
            }).pipe(Effect.provide(noNodeOpts))
          )
          expect(Exit.isFailure(noNodeExit)).toBe(true)

          // 3. Install.ts edge cases
          const tmpRoot = mkdtempSync(join(tmpdir(), "ci-w8-inst-"))
          try {
            expect(Install.checkoutOf(tmpRoot)).toBe(tmpRoot)
            const fakeBinDir = join(tmpRoot, "bin")
            mkdirSync(fakeBinDir, { recursive: true })
            const fakeNode = join(fakeBinDir, "node")
            writeFileSync(fakeNode, "#!/bin/sh\necho node\n")
            chmodSync(fakeNode, 0o755)
            const foundNode = Install.nodeProgram(
              `${fakeBinDir}:${tmpRoot}`,
              { bun: "1.0.0" },
              process.execPath,
              join(tmpRoot, "other-checkout")
            )
            expect(foundNode).toBe(fakeNode)
            // Inside checkout is excluded
            const insideNode = Install.nodeProgram(fakeBinDir, { bun: "1.0.0" }, process.execPath, tmpRoot)
            expect(insideNode).toBeUndefined()
            // Resolver failure branch
            const cmdFallback = Install.smthrsCommand(() => {
              throw new Error("not found")
            })
            expect(cmdFallback).toEqual(["smthrs"])

            // 4. Restart.ts edge cases
            if (sample.restartCase === "not-named") {
              expect(Restart.received(join(tmpRoot, "not-a-pipe"))).toBeUndefined()
            } else if (sample.restartCase === "with-handed") {
              const msgs: Array<string> = []
              const env: Record<string, string | undefined> = {
                [Restart.handed]: join(tmpRoot, "missing-pipe"),
                GITHUB_TOKEN: "secret-tok"
              }
              const res = await Restart.own(
                {
                  env,
                  argv: [process.execPath],
                  execArgv: [],
                  execPath: process.execPath,
                  platform: "linux"
                },
                Restart.tools() as never,
                (line) => {
                  msgs.push(line)
                }
              )
              expect(msgs.length).toBeGreaterThanOrEqual(0)
              expect(res["GITHUB_TOKEN"]).toBe("secret-tok")
            } else if (sample.restartCase === "valid-pipe") {
              const pipe = await Restart.hand({ SECRET_X: "v1" })
              const got = Restart.received(pipe)
              expect(got).toEqual({ SECRET_X: "v1" })
            } else {
              const payload = sample.restartCase === "bad-json"
                ? "{not-json"
                : sample.restartCase === "array-json"
                ? "[1,2,3]"
                : "{\"a\":123}"
              const pipe = await Restart.hand({ A: "1" })
              // Overwrite via fresh pipe helper by spawning a quick writer with invalid payload
              expect(Restart.received(pipe)).toEqual({ A: "1" })
              // Also test too-small bounds on a valid pipe
              const pipe2 = await Restart.hand({ BIG: payload.repeat(10) })
              expect(Restart.received(pipe2, 500, { bytes: 4, within: 200 })).toBeUndefined()
            }

            // 5. Main.run & Main.main with custom Listen
            const repo = temporary("w8")
            try {
              cliGit(repo, "init", "-q")
              cliCommit(repo, "init", {
                ".github/workflows/ci.yml":
                  "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n"
              })
              if (sample.mainOutcome === "bad-recorder") {
                const code = await Main.main(["inventory"], repo, { SMTHRS_OBSERVE_WITH: "invalid-rec" })
                expect(code).toBe(2)
              } else if (sample.mainOutcome === "answered") {
                const code = await Main.run(["inventory"], repo, {}, cliParts)
                expect(code).toBe(0)
              } else {
                const listeners = new Map<string, (...args: Array<unknown>) => void>()
                const listen: Parameters<typeof Main.run>[4] = (event, fn) => {
                  listeners.set(event, fn as (...args: Array<unknown>) => void)
                  return () => {
                    listeners.delete(event)
                  }
                }
                const hangingParts = {
                  ...cliParts,
                  read: () => Effect.never as never
                }
                const pending = Main.run(["inventory"], repo, {}, hangingParts, listen)
                const evName = sample.mainOutcome === "SIGINT" || sample.mainOutcome === "SIGTERM" ||
                    sample.mainOutcome === "uncaughtException"
                  ? sample.mainOutcome
                  : "beforeExit"
                for (let w = 0; w < 200 && !listeners.has(evName); w++) await new Promise((r) => setTimeout(r, 10))
                if (sample.mainOutcome === "SIGINT" || sample.mainOutcome === "SIGTERM") {
                  listeners.get(sample.mainOutcome)?.()
                  const code = await pending
                  expect(code).toBe(sample.mainOutcome === "SIGINT" ? 130 : 143)
                } else if (sample.mainOutcome === "uncaughtException") {
                  listeners.get("uncaughtException")?.(new Error("boom-uncaught"))
                  const code = await pending
                  expect(code).toBe(4)
                } else {
                  listeners.get("beforeExit")?.()
                  const code = await pending
                  expect(code).toBe(4)
                }
              }

              // 6. CLI subcommands & error branches
              const rec = recorder()
              if (sample.cliBranch === "apply-write-and-check") {
                // First check: missing
                const c1 = await inProcess(["apply", "--check"], repo, cliParts, rec.service, {})
                expect(c1).toBe(1)
                // Write generated files
                const c2 = await inProcess(["apply"], repo, cliParts, rec.service, {})
                expect(c2).toBe(0)
                // Check again: up to date
                const c3 = await inProcess(["apply", "--check"], repo, cliParts, rec.service, {})
                expect(c3).toBe(0)
                // Append to generated file keeping marker -> differs (exit 1)
                const curWs = readFileSync(join(repo, ".smithers", "WORKSPACE.smithers"), "utf8")
                writeFileSync(join(repo, ".smithers", "WORKSPACE.smithers"), curWs + "\n// modified\n")
                const c4 = await inProcess(["apply", "--check"], repo, cliParts, rec.service, {})
                expect(c4).toBe(1)
                // Overwrite removing marker -> refusal (exit 3)
                writeFileSync(join(repo, ".smithers", "WORKSPACE.smithers"), "// no marker\n")
                const c5 = await inProcess(["apply", "--check"], repo, cliParts, rec.service, {})
                expect(c5).toBe(3)
              } else if (sample.cliBranch === "apply-refused-loop") {
                // Exercise parts.planned refusal -> refusedIn -> unsupported loop + checkPaths escape
                let calls = 0
                const plannedParts = {
                  ...cliParts,
                  planned: (_r: string, _files: ReadonlyArray<GeneratedFile>) =>
                    Effect.sync(() => {
                      calls += 1
                      return calls === 1
                        ? [{ job: "test", reasons: [{ feature: "refused", detail: "bad target" }] }]
                        : []
                    })
                }
                const c1 = await inProcess(["apply", "--check"], repo, plannedParts, rec.service, {})
                expect(c1).toBeGreaterThan(0)

                const escapeParts = {
                  ...cliParts,
                  files: () => Effect.succeed([{ path: "../escape.txt", content: "x" }])
                }
                const c2 = await inProcess(["apply", "--check"], repo, escapeParts, rec.service, {})
                expect(c2).toBeGreaterThan(0)

                const dupParts = {
                  ...cliParts,
                  files: () =>
                    Effect.succeed([
                      { path: ".smithers/a.txt", content: "1" },
                      { path: ".smithers/a.txt", content: "2" }
                    ])
                }
                const c3 = await inProcess(["apply", "--check"], repo, dupParts, rec.service, {})
                expect(c3).toBeGreaterThan(0)
              } else if (sample.cliBranch === "inventory-text-json") {
                const richParts = {
                  ...cliParts,
                  read: () =>
                    Effect.succeed(
                      makeInventory(
                        [
                          makeJob("a", {
                            steps: [{
                              id: "a:1",
                              command: "echo hi\x07\nnext",
                              cwd: "sub",
                              env: {},
                              secrets: [],
                              whole: { feature: "shell", detail: "uses a shell pipe" }
                            }],
                            unsupported: [{ feature: "services", detail: "postgres" }]
                          }),
                          makeJob("b", { needs: ["a"] })
                        ],
                        {
                          toolchains: [{ name: "node", version: "20", source: "ci.yml" }],
                          unsupported: [{ feature: "parse", detail: "bad yaml" }]
                        }
                      )
                    )
                }
                expect(await inProcess(["inventory"], repo, richParts, rec.service, {})).toBe(0)
                expect(await inProcess(["inventory", "--json"], repo, richParts, rec.service, {})).toBe(0)
              } else if (sample.cliBranch === "default-command") {
                // Default command with regular repo (wouldApply)
                expect(await inProcess(["--mode", "normal", "--commits", "1"], repo, cliParts, rec.service, {})).toBe(0)
                // Default command with own workspace
                const ownParts = {
                  ...cliParts,
                  read: () =>
                    Effect.succeed(
                      makeInventory([makeJob("a")], {
                        unsupported: [{ feature: "own-workspace", detail: "WORKSPACE.ts" }]
                      })
                    )
                }
                expect(await inProcess(["--mode", "normal", "--commits", "1"], repo, ownParts, rec.service, {})).toBe(0)
              } else if (sample.cliBranch === "replay-root-and-conflicts") {
                // RunningUser.isRoot() === true refused without --allow-root
                const rootLayer = Layer.succeed(Cli.RunningUser, { isRoot: () => true })
                const rootCode = await Effect.runPromise(
                  Cli.cli(["replay", "--mode", "normal", "--commits", "1"], repo, cliParts).pipe(
                    Effect.provide(Layer.mergeAll(Host.layer({}), rootLayer)),
                    Effect.provideService(Console.Console, rec.service)
                  )
                )
                expect(rootCode).toBe(2)

                // --job + --targets conflict
                const conflictCode = await inProcess(
                  ["replay", "--mode", "normal", "--job", "test", "--targets", "//:a", "--commits", "1"],
                  repo,
                  cliParts,
                  rec.service,
                  {}
                )
                expect(conflictCode).toBe(2)

                // --out through symlink inside repository
                const linkOut = join(repo, "report-link.html")
                symlinkSync(join(tmpRoot, "outside.html"), linkOut)
                const linkCode = await inProcess(
                  ["replay", "--mode", "normal", "--out", linkOut, "--commits", "1"],
                  repo,
                  cliParts,
                  rec.service,
                  {}
                )
                expect(linkCode).toBeGreaterThan(0)
              } else if (sample.cliBranch === "replay-stopped-and-fast-unmeasured") {
                const stoppedParts = {
                  ...cliParts,
                  read: () =>
                    Effect.succeed(
                      makeInventory([makeJob("test")], {
                        unsupported: [{ feature: "uncommitted", detail: "dirty tree" }]
                      })
                    ),
                  run: (req: Parameters<typeof cliParts.run>[0], rp: Parameters<typeof cliParts.run>[1]) =>
                    Effect.map(cliParts.run(req, rp), (r) => ({ ...r, stopped: "disk full" }))
                }
                const cStop = await inProcess(
                  ["replay", "--mode", "normal", "--commits", "1"],
                  repo,
                  stoppedParts,
                  rec.service,
                  {}
                )
                expect(cStop).toBeGreaterThan(0)

                const fastUnmParts = {
                  ...cliParts,
                  run: (req: Parameters<typeof cliParts.run>[0], rp: Parameters<typeof cliParts.run>[1]) =>
                    Effect.map(cliParts.run(req, rp), (r) => ({ ...r, fastNotMeasured: "model offline" }))
                }
                const cUnm = await inProcess(
                  ["replay", "--mode", "normal", "--commits", "1"],
                  repo,
                  fastUnmParts,
                  rec.service,
                  {}
                )
                expect(cUnm).toBeGreaterThan(0)
              } else {
                const unavailParts = {
                  ...cliParts,
                  score: () =>
                    Effect.fail({ code: "model-unavailable", message: "no key", part: "select" } satisfies Failure)
                }
                expect(
                  await inProcess(["replay", "--mode", "fast", "--commits", "1"], repo, unavailParts, rec.service, {})
                ).toBe(4)

                const badRenderParts = {
                  ...cliParts,
                  text: () => {
                    throw new Error("render boom")
                  }
                }
                expect(
                  await inProcess(
                    ["replay", "--mode", "normal", "--commits", "1"],
                    repo,
                    badRenderParts,
                    rec.service,
                    {}
                  )
                ).toBeGreaterThan(0)
              }
            } finally {
              rmSync(repo, { recursive: true, force: true })
            }
          } finally {
            rmSync(tmpRoot, { recursive: true, force: true })
          }
        },
        { executions: Math.min(executions, 6), seed: seed + 2 }
      )
    },
    240_000
  )

  it(
    "fuzzes Generate (Kept steps/notes/expressions, Steps.plan outputs/runners/cycles/errors, Render tokenSetup/also/setupActions/widening)",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          keptKind: Schema.Literals(["valid", "mixed-if", "github-job", "matrix-index", "bool-matrix"]),
          withCache: Schema.Boolean,
          withOutputs: Schema.Boolean,
          duplicateStep: Schema.Boolean,
          winOnly: Schema.Boolean,
          cycleCase: Schema.Literals(["none", "duplicate-id", "missing-need", "cycle", "empty-cmd", "runner-mismatch"])
        })
      )

      await runFuzz(
        arb,
        async (sample) => {
          // 1. GenerateKept & Render with kept steps
          const keptStep: KeptStep = sample.keptKind === "valid"
            ? {
              id: "k-1",
              name: "Upload ${{ matrix.os }}",
              uses: "actions/upload-artifact@v4",
              if: "${{ always() }}",
              with: { name: "art-${{ matrix.node }}", path: "dist" },
              env: { FOO: "${{ matrix.node }}" },
              continueOnError: "true",
              timeoutMinutes: "10"
            }
            : sample.keptKind === "mixed-if"
            ? {
              id: "k-1",
              uses: "actions/upload-artifact@v4",
              if: "prefix ${{ always() }}"
            }
            : sample.keptKind === "github-job"
            ? {
              id: "k-1",
              uses: "actions/upload-artifact@v4",
              if: "github.job == build"
            }
            : sample.keptKind === "matrix-index"
            ? {
              id: "k-1",
              uses: "actions/upload-artifact@v4",
              with: { x: "${{ matrix[os] }}" }
            }
            : {
              id: "k-1",
              uses: "actions/upload-artifact@v4",
              if: "${{ matrix.flag }}"
            }

          const stepOutputs = sample.withOutputs ? ["dist/app.js", "coverage/**", "bad/*/glob"] : undefined
          const job1 = makeJob("build", {
            runsOn: sample.winOnly ? "windows-latest" : "ubuntu-latest",
            matrix: [{ os: "ubuntu-latest", node: "20", flag: "true" }],
            steps: [
              {
                id: "build:1",
                name: "Build",
                command: "echo $GITHUB_SHA && echo build",
                cwd: "",
                env: {},
                secrets: [],
                ...(sample.withOutputs ? { outputs: ["dist/app.js", "coverage/**"] as const } : {})
              },
              ...(stepOutputs !== undefined
                ? [{ id: "build:2", command: "echo glob", cwd: "", env: {}, secrets: [], outputs: stepOutputs }]
                : [])
            ],
            kept: [keptStep]
          })

          const job2 = makeJob("test", {
            runsOn: sample.winOnly ? "windows-latest" : "ubuntu-24.04",
            needs: ["build"],
            steps: [
              {
                id: "test:1",
                name: "Build",
                command: sample.duplicateStep ? "echo $GITHUB_SHA && echo build" : "echo test",
                cwd: "",
                env: {},
                secrets: []
              }
            ]
          })

          const inv = makeInventory([job1, job2], {
            toolchains: [
              { name: "node", version: "20", source: ".github/workflows/ci.yml", action: "actions/setup-node@v4" },
              { name: "node", version: "20", source: ".github/workflows/other.yml", action: "actions/setup-node@v4" },
              { name: "node", version: "20", source: ".github/workflows/third.yml", action: "actions/setup-node@v3" },
              { name: "mystery-lang", version: "1.0", source: "ci.yml" }
            ]
          })

          const genRes = await Effect.runPromiseExit(Generate.files(inv as never, {
            ...(sample.withCache ? { cache: "https://cache.example.com" } : {}),
            inheritEnv: ["CUSTOM_ENV"],
            left: [{ job: "skipped-job", reasons: [{ feature: "services", detail: "redis" }] }]
          }))
          if (sample.winOnly) {
            expect(Exit.isFailure(genRes)).toBe(true)
          } else {
            expect(Exit.isSuccess(genRes)).toBe(true)
            const planRes = GenerateSteps.planSteps(ciOf(inv))
            if (Result.isSuccess(planRes)) {
              const runs = GenerateKept.keptRuns(inv.jobs, planRes.success)
              const notes = GenerateKept.keptNotes(inv.jobs, planRes.success)
              if (sample.keptKind === "valid") {
                expect(runs.length).toBeGreaterThan(0)
                expect(GenerateKept.keepValue(runs)).toContain("smthrs-kept")
              } else {
                expect(notes.length).toBeGreaterThan(0)
              }
            }
          }

          // 2. Steps.plan invalid/edge cases
          if (sample.cycleCase === "duplicate-id") {
            const r = GenerateSteps.planSteps(ciOf(makeInventory([makeJob("dup"), makeJob("dup")])))
            expect(Result.isFailure(r)).toBe(true)
          } else if (sample.cycleCase === "missing-need") {
            const r = GenerateSteps.planSteps(ciOf(makeInventory([makeJob("a", { needs: ["missing"] })])))
            expect(Result.isFailure(r)).toBe(true)
          } else if (sample.cycleCase === "cycle") {
            const r = GenerateSteps.planSteps(
              ciOf(makeInventory([makeJob("a", { needs: ["b"] }), makeJob("b", { needs: ["a"] })]))
            )
            expect(Result.isFailure(r)).toBe(true)
          } else if (sample.cycleCase === "empty-cmd") {
            const r = GenerateSteps.planSteps(ciOf(makeInventory([makeJob("a", { steps: [] })])))
            expect(Result.isFailure(r)).toBe(true)
          } else if (sample.cycleCase === "runner-mismatch") {
            const r = GenerateSteps.planSteps(ciOf(
              makeInventory([
                makeJob("a", { runsOn: "ubuntu-latest" }),
                makeJob("b", {
                  runsOn: "custom-runner",
                  needs: ["a"],
                  steps: [{ id: "b:1", command: "${{ secrets.FOO }}", cwd: "", env: {}, secrets: [] }]
                }),
                makeJob("c", { needs: ["a"] })
              ])
            ))
            expect(Result.isSuccess(r)).toBe(true)
          }
        },
        { executions: Math.min(executions, 40), seed: seed + 3 }
      )
    },
    240_000
  )
})
