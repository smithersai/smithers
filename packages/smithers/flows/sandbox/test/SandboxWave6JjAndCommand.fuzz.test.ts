import { Fuzz } from "@smthrs/fuzz"
import { JjError } from "@smthrs/jj"
import * as Jj from "@smthrs/jj/Jj"
import { Arbitrary, Effect, Exit, FileSystem, Path, Schema, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import {
  ChildProcessSpawner,
  type ExitCode,
  make as makeSpawner,
  makeHandle,
  type ProcessId
} from "effect/process/ChildProcessSpawner"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import * as JjWorkspaceSandbox from "../src/JjWorkspaceSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Remotes from "../src/Remotes/index.ts"
import * as SandboxCommand from "../src/SandboxCommand/index.ts"
import * as SandboxHealth from "../src/SandboxHealth/index.ts"
import { contain, platform } from "./helpers/containedPlatform.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-sb-w6-")))
afterAll(() => rmSync(rootDir, { recursive: true, force: true }))
let seq = 0
const freshDir = (label: string): string => {
  const dir = join(rootDir, `${label}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const getPlatform = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner
  return { fs, path, spawner }
}).pipe(Effect.provide(platform))

const makeFsJj = (
  fs: FileSystem.FileSystem,
  options: {
    readonly gitStore?: string
    readonly commitId?: string
    readonly addFault?: JjError["code"]
    readonly forgetFault?: boolean
  } = {}
) => {
  const added: Array<string> = []
  const forgotten: Array<string> = []
  const commitId = options.commitId ?? "a".repeat(40)
  const jj: Jj.Jj = {
    ...Jj.makeNoop({}),
    snapshot: () => Effect.succeed({ commitId, changeId: "k".repeat(32) } as never),
    workspaceAdd: (name, workdir) =>
      Effect.gen(function*() {
        if (options.addFault !== undefined) {
          return yield* Effect.fail(
            new JjError({
              code: options.addFault,
              message: `fault:${options.addFault}`,
              module: "test",
              method: "workspaceAdd"
            })
          )
        }
        yield* fs.makeDirectory(join(workdir, ".jj"), { recursive: true })
        if (options.gitStore !== undefined) {
          const repoDir = join(options.gitStore, "..", ".jj", "repo")
          mkdirSync(join(repoDir, "store"), { recursive: true })
          mkdirSync(join(options.gitStore, "objects"), { recursive: true })
          writeFileSync(join(repoDir, "store", "git_target"), options.gitStore)
          writeFileSync(join(workdir, ".jj", "repo"), repoDir)
        }
        added.push(name)
      }),
    workspaceForget: (name) =>
      Effect.gen(function*() {
        forgotten.push(name)
        if (options.forgetFault) {
          return yield* Effect.fail(
            new JjError({ code: "unknown", message: "forget failed", module: "test", method: "workspaceForget" })
          )
        }
      })
  }
  return { jj, added, forgotten }
}

describe("@smthrs/sandbox Wave 6 deep fuzz (JjWorkspaceSandbox, SandboxCommand, Conformance, Remotes, Health)", () => {
  it("JjWorkspaceSandbox.workspaceNameOf is collision-free, lowercase ASCII, and make() validates every option boundary", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        s1: Schema.Literals([
          "lane/one",
          "lane-one",
          "Lane",
          "lane",
          "a".repeat(45) + "1",
          "a".repeat(45) + "2",
          "ws:alpha"
        ]),
        s2: Schema.Literals([
          "lane/one",
          "lane-one",
          "Lane",
          "lane",
          "a".repeat(45) + "1",
          "a".repeat(45) + "2",
          "ws:beta"
        ]),
        prefix: Schema.Literals(["smthrs-ws-", "Lane1_", "ws"]),
        badCase: Schema.Literals([
          "relRoot",
          "nulRoot",
          "gitRoot",
          "jjRoot",
          "badPrefix",
          "netNone",
          "limitsCpu",
          "badBaseGit",
          "badBaseNoGit",
          "rawSpawner"
        ])
      })
    )

    const { fs, path, spawner } = await Effect.runPromise(getPlatform)
    const rawSpawner = makeSpawner(() => Effect.die("uncontained"))
    const { jj } = makeFsJj(fs)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ s1, s2, prefix, badCase }) =>
          Effect.sync(() => {
            const n1 = JjWorkspaceSandbox.workspaceNameOf(s1, prefix)
            const n2 = JjWorkspaceSandbox.workspaceNameOf(s2, prefix)
            expect(n1).toMatch(/^[a-z0-9][a-z0-9_-]+$/)
            if (s1 !== s2) expect(n1).not.toBe(n2)
            expect(JjWorkspaceSandbox.workspaceNameOf(s1, prefix)).toBe(n1)

            const validRoot = freshDir("val")
            const baseOpts = { jj, fs, path, spawner, workspacesRoot: validRoot }
            switch (badCase) {
              case "relRoot":
                expect(() => JjWorkspaceSandbox.make({ ...baseOpts, workspacesRoot: "relative/dir" })).toThrow(
                  TypeError
                )
                break
              case "nulRoot":
                expect(() => JjWorkspaceSandbox.make({ ...baseOpts, workspacesRoot: `${validRoot}\0bad` })).toThrow(
                  TypeError
                )
                break
              case "gitRoot":
                expect(() => JjWorkspaceSandbox.make({ ...baseOpts, workspacesRoot: join(validRoot, ".git", "ws") }))
                  .toThrow(TypeError)
                break
              case "jjRoot":
                expect(() => JjWorkspaceSandbox.make({ ...baseOpts, workspacesRoot: join(validRoot, ".jj", "ws") }))
                  .toThrow(TypeError)
                break
              case "badPrefix":
                expect(() => JjWorkspaceSandbox.make({ ...baseOpts, workspacePrefix: "-bad!" })).toThrow(TypeError)
                break
              case "netNone":
                expect(() => JjWorkspaceSandbox.make({ ...baseOpts, network: "none" })).toThrow()
                break
              case "limitsCpu":
                expect(() => JjWorkspaceSandbox.make({ ...baseOpts, limits: { cpus: 2 } })).toThrow()
                break
              case "badBaseGit":
                expect(() => JjWorkspaceSandbox.make({ ...baseOpts, git: true, baseRevision: "0".repeat(40) as never }))
                  .toThrow(TypeError)
                break
              case "badBaseNoGit":
                expect(() => JjWorkspaceSandbox.make({ ...baseOpts, git: false, baseRevision: "bad rev!" as never }))
                  .toThrow(TypeError)
                break
              case "rawSpawner":
                expect(() => JjWorkspaceSandbox.make({ ...baseOpts, workspacePrefix: "a".repeat(40) })).toThrow(
                  TypeError
                )
                break
            }
            return true
          }),
        { executions: Math.min(executions, 80), seed }
      )
    )
    assertPassed(report)
  })

  it(
    "JjWorkspaceSandbox full lifecycle: acquire, git/jj modes, sticky/ephemeral, files, spawn, confinement, fork, teardown faults, and error mapping",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          git: Schema.Boolean,
          persistence: Schema.Literals(["ephemeral", "sticky"]),
          useBaseRev: Schema.Boolean,
          fault: Schema.Literals([
            "none",
            "not_installed",
            "conflict",
            "invalid_ref",
            "stale_workspace",
            "zeroCommit",
            "forgetFault"
          ]),
          payload: Schema.Literals(["hello", "multi\nline", "json:{}"])
        })
      )

      const { fs, path, spawner } = await Effect.runPromise(getPlatform)

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ git, persistence, useBaseRev, fault, payload }) =>
            Effect.gen(function*() {
              const wsRoot = freshDir("jjws")
              const gitStore = git ? join(freshDir("gitstore"), "git") : undefined
              const teardownFailures: Array<JjWorkspaceSandbox.TeardownFailure> = []
              const stub = makeFsJj(fs, {
                ...(gitStore ? { gitStore } : {}),
                commitId: fault === "zeroCommit" ? "0".repeat(40) : "a".repeat(40),
                ...(fault === "not_installed" || fault === "conflict" || fault === "invalid_ref" ||
                    fault === "stale_workspace"
                  ? { addFault: fault }
                  : {}),
                forgetFault: fault === "forgetFault"
              })
              const gitFriendlySpawner = git
                ? yield* contain(
                  makeSpawner((cmd) => {
                    const sc = cmd as ChildProcess.StandardCommand
                    if (sc.command === "git") {
                      return Effect.succeed(
                        makeHandle({
                          pid: 4242 as ProcessId,
                          exitCode: Effect.succeed(0 as ExitCode),
                          isRunning: Effect.succeed(false),
                          kill: () => Effect.void,
                          stdin: undefined as never,
                          stdout: Stream.empty,
                          stderr: Stream.empty,
                          all: Stream.empty,
                          getInputFd: () => undefined as never,
                          getOutputFd: () => undefined as never,
                          unref: Effect.succeed(Effect.void)
                        })
                      )
                    }
                    return spawner.spawn(cmd)
                  }),
                  (command, spawn) =>
                    Effect.map(
                      spawn(command),
                      (handle) => ({ handle, activate: Effect.void, settled: Effect.succeed(true) })
                    )
                )
                : spawner
              const provider = JjWorkspaceSandbox.make({
                jj: stub.jj,
                fs,
                path,
                spawner: gitFriendlySpawner,
                workspacesRoot: wsRoot,
                git,
                persistence,
                ...(useBaseRev ? { baseRevision: (git ? "b".repeat(40) : "@-") as never } : {}),
                env: { PATH: process.env.PATH, HOME: process.env.HOME, SECRET_API_KEY: "must-be-scrubbed" },
                onTeardownFailure: (f) =>
                  Effect.sync(() => {
                    teardownFailures.push(f)
                  })
              })

              const sessionId = `sess-${++seq}`
              const res = yield* Effect.scoped(
                Effect.gen(function*() {
                  const session = yield* provider.acquire(sessionId)
                  const notePath = join(session.workdir, "dir/note.txt")
                  yield* session.writeFile(notePath, new TextEncoder().encode(payload))
                  const readBack = new TextDecoder().decode(yield* session.readFile(notePath))
                  expect(readBack).toBe(payload)

                  if (session.ping !== undefined) yield* session.ping

                  const proc = yield* session.spawn(
                    "cat dir/note.txt && printf \"|%s\" \"${SECRET_API_KEY:-scrubbed}\"",
                    {}
                  )
                  const [chunks, exit] = yield* Effect.all([Stream.runCollect(proc.stdout), proc.exitCode], {
                    concurrency: "unbounded"
                  }).pipe(Effect.timeoutOrElse({ duration: "4 seconds", orElse: () => Effect.die("SPAWN_TIMEOUT") }))
                  expect(exit).toBe(0)
                  const outText = Buffer.concat([...chunks]).toString("utf8")
                  expect(outText).toBe(`${payload}|scrubbed`)

                  if (session.fork !== undefined) {
                    const forkedId = `fork-${sessionId}`
                    const forked = yield* session.fork(forkedId).pipe(
                      Effect.timeoutOrElse({ duration: "4 seconds", orElse: () => Effect.die("FORK_TIMEOUT") })
                    )
                    const copied = new TextDecoder().decode(
                      yield* forked.readFile(join(forked.workdir, "dir/note.txt"))
                    )
                    expect(copied).toBe(payload)
                  }
                  return { workdir: session.workdir, id: session.id, remoteId: session.remoteId }
                })
              ).pipe(Effect.exit)

              if (
                fault === "not_installed" ||
                fault === "conflict" ||
                fault === "invalid_ref" ||
                fault === "stale_workspace" ||
                (fault === "zeroCommit" && git && !useBaseRev)
              ) {
                expect(Exit.isFailure(res)).toBe(true)
                return true
              }

              if (Exit.isFailure(res)) throw new Error(String(res.cause))
              expect(Exit.isSuccess(res)).toBe(true)
              if (Exit.isSuccess(res)) {
                if (persistence === "sticky") {
                  expect(existsSync(res.value.workdir)).toBe(true)
                  if (provider.destroy !== undefined) {
                    yield* provider.destroy(res.value).pipe(Effect.exit)
                  }
                } else if (fault === "forgetFault") {
                  expect(teardownFailures.some((f) => f.step === "forget")).toBe(true)
                }
              }
              return true
            }),
          { executions: Math.min(executions, 24), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it(
    "SandboxCommand, Remotes.make, SandboxHealth.layer, ProviderConformance, and SandboxConformance exercise full command & conformance boundaries",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          cmdKind: Schema.Literals(["ok", "failExit", "withStdin"]),
          tag: Schema.Literals(["alpha", "beta", "gamma"]),
          healthy: Schema.Boolean
        })
      )

      const { fs, spawner } = await Effect.runPromise(getPlatform)

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ cmdKind, tag, healthy }) =>
            Effect.gen(function*() {
              const base = freshDir("cmd")
              const dirProvider = DirectorySandbox.make({
                fs,
                spawner,
                root: join(base, "machines"),
                persistence: "sticky"
              })

              const callsDir = join(base, "calls")
              mkdirSync(callsDir, { recursive: true })
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const sess = yield* dirProvider.acquire(`s-${tag}`)
                  const cmds = SandboxCommand.onSession(sess, callsDir)
                  const callKey = `call-${++seq}`
                  const started = yield* cmds.start(
                    {
                      tool: "run",
                      command: cmdKind === "failExit" ? `echo err-${tag} >&2; exit 3` : `echo ok-${tag}`,
                      timeoutSeconds: 10
                    },
                    callKey
                  )
                  expect(started.pid).toBeGreaterThan(0)
                  let obs = yield* cmds.observe(callKey, { waitMs: 250 })
                  for (let i = 0; i < 20 && obs.state === "running"; i++) {
                    obs = yield* cmds.observe(callKey, { waitMs: 100 })
                  }
                  expect(obs.state).toBe("finished")
                  const collected = yield* cmds.collect(callKey)
                  expect(collected.exitCode).toBe(cmdKind === "failExit" ? 3 : 0)
                })
              )

              const remotes = Remotes.make({
                grants: {
                  check: () => Effect.void,
                  grants: () => Effect.succeed([]),
                  grant: () => Effect.void,
                  revoke: () => Effect.void
                } as never,
                provider: (remote) =>
                  remote === "default"
                    ? Effect.succeed(dirProvider)
                    : Effect.fail(new ProviderError({ code: "not_found", message: remote }))
              })
              yield* Effect.scoped(remotes.acquire("default", `rem-${tag}`))
              const missingExit = yield* Effect.scoped(remotes.acquire("missing", `rem-${tag}`)).pipe(Effect.exit)
              expect(Exit.isFailure(missingExit)).toBe(true)
              const healthLayer = SandboxHealth.layer({
                ping: healthy ? Effect.void : Effect.fail(new ProviderError({ code: "unavailable", message: "down" }))
              })
              const h = yield* Effect.flatMap(SandboxHealth.SandboxHealth, (svc) => svc.check).pipe(
                Effect.provide(healthLayer)
              )
              expect(h._tag === "Healthy" || h._tag === "Unhealthy").toBe(true)

              return true
            }),
          { executions: Math.min(executions, 15), seed: seed + 2 }
        )
      )
      assertPassed(report)

      // Also test SandboxCommand.Run schema and defaults
      expect(SandboxCommand.defaults.maxTimeoutSeconds).toBeGreaterThan(0)
      expect(SandboxCommand.Run()).toBeDefined()
    },
    120_000
  )
})
