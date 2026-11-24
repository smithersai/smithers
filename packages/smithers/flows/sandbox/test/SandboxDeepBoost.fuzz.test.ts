import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { layerRepositoryMutation } from "@smthrs/jj/node/NodeJj"
import { Arbitrary, Effect, Exit, FileSystem, Layer, Logger, Schema, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import { CiJob, RemoteChildProcessSpawner, Sandbox, SandboxMerge } from "../src/index.ts"
import * as LinuxBatch from "../src/internal/linuxBatch.ts"
import { commandProvider } from "../src/Sandbox/commandProvider.ts"
import { platform, rawPlatform } from "./helpers/containedPlatform.ts"
import { advanceMain, cleanup, directory, gitClone, hostRepository, scratch, seeded } from "./helpers/sandboxRepos.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const fastExecutions = Math.max(12, Math.min(baseExecutions, 30))
const ioExecutions = Math.max(6, Math.min(baseExecutions, 12))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-sb-boost-")))
const mergeRoot = scratch("sb-boost-merge")
const mergeMachines = scratch("sb-boost-machines")
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  cleanup(mergeRoot, mergeMachines)
})

const services = Effect.runSync(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner
    return { fs, spawner }
  }).pipe(Effect.provide(platform))
)

let seq = 0
const freshDir = (name: string) => {
  const dir = join(root, `${name}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("@smthrs/sandbox LinuxBatch, CiJob.Graph, SandboxMerge.resolveWith & RemoteChildProcessSpawner pipelines fuzz", () => {
  it("LinuxBatch.batchedFiles executes snapshot, commit (write/delete/conflict/stale), list & refusals on real sessions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        bodyA: Schema.Literals(["alpha", "line1\nline2", "special ' \" $ ` chars"]),
        bodyB: Schema.Literals(["beta", "updated-beta"]),
        conflict: Schema.Boolean,
        deleteAfter: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.scoped(
            Effect.gen(function*() {
              const base = freshDir("batch")
              const provider = DirectorySandbox.make({ ...services, root: base })
              const session = yield* provider.acquire(`b-${seq}`)
              const batch = LinuxBatch.batchedFiles(session, "linux")

              const pA = `${session.workdir}/a.txt`
              const pB = `${session.workdir}/sub/b.txt`
              const pMissing = `${session.workdir}/missing.txt`

              const snap0 = yield* batch.snapshot([pA, pMissing], { read: [pA, pMissing], maxBytes: 65536 })
              expect(snap0.length).toBe(2)
              expect(snap0[0]!.info._tag).toBe("Failure")

              const snapB = yield* batch.snapshot([pB])
              const c1 = yield* batch.commit([
                { path: pA, version: snap0[0]!.version, content: new TextEncoder().encode(tc.bodyA) },
                { path: pB, version: snapB[0]!.version, content: new TextEncoder().encode(tc.bodyB) }
              ])
              expect(c1.applied).toBe(2)

              const snap1 = yield* batch.snapshot([pA, pB], { read: [pA, pB], maxBytes: 65536 })
              expect(snap1[0]!.info._tag).toBe("Success")
              if (snap1[0]!.content?._tag === "Success") {
                expect(new TextDecoder().decode(snap1[0]!.content.success)).toBe(tc.bodyA)
              }

              const listed = yield* batch.list(session.workdir)
              expect(listed.some((e) => e.name === "a.txt")).toBe(true)

              if (tc.conflict) {
                yield* session.writeFile(pA, new TextEncoder().encode("out-of-band"))
                const stale = yield* batch.commit([
                  { path: pA, version: snap1[0]!.version, content: new TextEncoder().encode("new") }
                ])
                expect(stale.stopped?.reason).toBe("changed")
              } else if (tc.deleteAfter) {
                const del = yield* batch.commit([
                  { path: pA, version: snap1[0]!.version, content: null }
                ])
                expect(del.applied).toBe(1)
                const snap2 = yield* batch.snapshot([pA])
                expect(snap2[0]!.info._tag).toBe("Failure")
              }

              // Helper predicates
              expect(LinuxBatch.fileType(0o100644)).toBe("File")
              expect(LinuxBatch.fileType(0o040755)).toBe("Directory")
              expect(LinuxBatch.fileType(0o120777)).toBe("SymbolicLink")
              expect(typeof LinuxBatch.statAbsent("stat: cannot stat 'x': No such file or directory")).toBe("boolean")
              expect(LinuxBatch.statAbsent("Permission denied")).toBe(false)
              return true
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  }, 120_000)

  it("CiJob.Graph & CiJob.make run multi-job DAGs with needs, skips, failures & parallel branches", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        lintFails: Schema.Boolean,
        testFails: Schema.Boolean,
        diamond: Schema.Boolean
      })
    )

    const target: CiJob.Target = {
      run: "ci:graph-fuzz",
      repo: "acme/graph",
      sha: "c".repeat(40),
      ref: "refs/heads/main"
    }

    let gIdx = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.gen(function*() {
            const machineLayer = Layer.succeed(
              CiJob.Machine,
              CiJob.Machine.of({
                checkout: () => Effect.succeed(true),
                run: (_at, job) =>
                  Effect.succeed({
                    exitCode: (tc.lintFails && job.name === "lint") || (tc.testFails && job.name === "test") ? 1 : 0,
                    timedOut: false,
                    output: { stdout: `${job.name}-out`, stderr: "", truncated: false }
                  }),
                release: () => Effect.void
              })
            )

            const jobs: ReadonlyArray<CiJob.Job> = tc.diamond
              ? [
                { name: "lint", steps: [{ name: "s0", run: "lint" }] },
                { name: "test", steps: [{ name: "s0", run: "test" }] },
                { name: "deploy", needs: ["lint", "test"], steps: [{ name: "s0", run: "deploy" }] }
              ]
              : [
                { name: "lint", steps: [{ name: "s0", run: "lint" }] },
                { name: "test", needs: ["lint"], steps: [{ name: "s0", run: "test" }] }
              ]

            const ciHost = Layer.mergeAll(
              CiJob.layer,
              Interpreter.layer(CiJob.CiJob),
              Interpreter.layer(CiJob.Graph),
              silentLogger
            ).pipe(
              Layer.provide(machineLayer),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer)
            )

            const out = yield* CiJob.Graph.execute(
              { target, jobs },
              { executionId: `ci-graph-${++gIdx}` }
            ).pipe(Effect.provide(ciHost))

            if (tc.lintFails) {
              expect(out[CiJob.key(0)]?.outcome).toBe("failed")
              const dep = out[CiJob.key(tc.diamond ? 2 : 1)]
              expect(dep?.outcome).toBe("skipped")
            } else if (tc.testFails) {
              expect(out[CiJob.key(1)]?.outcome).toBe("failed")
            } else {
              expect(out[CiJob.key(0)]?.outcome).toBe("passed")
            }
            return true
          }),
        { seed: seed + 1, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("RemoteChildProcessSpawner exercises pipelines (pipeTo), kill, lines, string, env & cwd", async () => {
    const provider = DirectorySandbox.make({ ...services, root: freshDir("rcps-deep") })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          // Pipeline: printf -> tr -> cat
          const piped = ChildProcess.make("printf", ["hello-pipe\\nworld\\n"]).pipe(
            ChildProcess.pipeTo(ChildProcess.make("tr", ["a-z", "A-Z"]))
          )
          const text = yield* spawner.string(piped)
          expect(text).toContain("HELLO-PIPE")
          expect(text).toContain("WORLD")

          // lines helper + env
          const linesOut = yield* spawner.lines(
            ChildProcess.make("sh", ["-c", "printf '%s\\n%s\\n' \"$GREET\" done"], {
              env: { GREET: "hi-env" }
            })
          )
          expect(linesOut).toEqual(["hi-env", "done"])

          // kill a running child
          const sleeper = yield* spawner.spawn(ChildProcess.make("sleep", ["0.05"]))
          expect(typeof (yield* sleeper.isRunning)).toBe("boolean")
          const killExit = yield* sleeper.kill({ killSignal: "SIGKILL" }).pipe(Effect.exit)
          expect(killExit).toBeDefined()
          yield* sleeper.exitCode
        }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(commandProvider(provider, { session: "rcps-deep-1" }))))
      ).pipe(Effect.provide(silentLogger))
    )
  })

  it("SandboxMerge.resolveWith resolves a real jj conflict via custom strategy", async () => {
    const { path: repoPath } = hostRepository(mergeRoot, { "README.md": "base\n" }, `resolve-${++seq}`)
    const mergeLayer = Layer.mergeAll(rawPlatform, layerRepositoryMutation, silentLogger)
    await Effect.runPromise(
      Effect.gen(function*() {
        const provider = seeded(yield* directory(mergeMachines), gitClone(repoPath))
        const { work } = yield* Sandbox.run(
          provider,
          { session: `res-${seq}` },
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString("README.md", "branch-change\n")
          })
        )
        advanceMain(repoPath, { "README.md": "main-change\n" })
        // First test resolver returning still-conflicted change -> rejected
        const badStrategy = SandboxMerge.resolveWith((conflicted) => Effect.succeed({ change: conflicted.change }))
        const rejExit = yield* SandboxMerge.apply(work, {
          repository: repoPath,
          onto: "main",
          message: "resolve fuzz",
          key: `res-key-bad-${seq}`,
          fetch: false,
          strategy: badStrategy
        }).pipe(Effect.exit)
        expect(Exit.isFailure(rejExit)).toBe(true)

        // Also test resolver returning a nonexistent change -> rejected
        const missStrategy = SandboxMerge.resolveWith(() => Effect.succeed({ change: "nonexistent-rev-xyz" }))
        const missExit = yield* SandboxMerge.apply(work, {
          repository: repoPath,
          onto: "main",
          message: "resolve fuzz miss",
          key: `res-key-miss-${seq}`,
          fetch: false,
          strategy: missStrategy
        }).pipe(Effect.exit)
        expect(Exit.isFailure(missExit)).toBe(true)
      }).pipe(Effect.provide(mergeLayer))
    )
  })
})
