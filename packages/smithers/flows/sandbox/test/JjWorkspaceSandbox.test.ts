import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { Capability, Permission } from "@smthrs/capability"
import { FlowEngine } from "@smthrs/engine"
import { Flow, Interpreter } from "@smthrs/flow"
import * as Jj from "@smthrs/jj/Jj"
import { layerAt, layerRepositoryMutation } from "@smthrs/jj/node/NodeJj"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, PlatformError, Scope, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import {
  type ChildProcessHandle,
  ChildProcessSpawner,
  type ExitCode,
  make as makeSpawner,
  makeHandle,
  type ProcessId
} from "effect/process/ChildProcessSpawner"
import * as esbuild from "esbuild"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll } from "vitest"
import * as JjWorkspaceSandbox from "../src/JjWorkspaceSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import * as SandboxMerge from "../src/SandboxMerge/index.ts"
import { contain, platform, rawPlatform } from "./helpers/containedPlatform.ts"
import { cleanup, commitOf, host, hostRepository, scratch } from "./helpers/sandboxRepos.ts"
import { untouchable } from "./helpers/untouchable.ts"
import { makeWorkSeed } from "./helpers/workSeed.ts"

const testRoot = scratch("jj-workspace-sandbox")
afterAll(() => cleanup(testRoot))

let counter = 0
const freshDir = (label: string): string => {
  const dir = join(testRoot, `${label}-${++counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const sampleSha1 = "a".repeat(40)
const sampleSha256 = "b".repeat(64)
const slow = { timeout: 120_000 }

const getPlatform = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner
  return { fs, path, spawner }
}).pipe(Effect.provide(platform))

const makeFakeHandle = (options?: {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly onKill?: (signal: ChildProcess.Signal) => Effect.Effect<void, PlatformError.PlatformError>
}): ChildProcessHandle => {
  const encoder = new TextEncoder()
  return makeHandle({
    pid: 4242 as ProcessId,
    exitCode: Effect.succeed((options?.exitCode ?? 0) as ExitCode),
    isRunning: Effect.succeed(false),
    kill: (killOptions) =>
      options?.onKill !== undefined
        ? options.onKill(killOptions?.killSignal ?? "SIGTERM")
        : Effect.void,
    stdin: undefined as never,
    stdout: options?.stdout === undefined ? Stream.empty : Stream.make(encoder.encode(options.stdout)),
    stderr: options?.stderr === undefined ? Stream.empty : Stream.make(encoder.encode(options.stderr)),
    all: Stream.empty,
    getInputFd: () => undefined as never,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void)
  })
}

const containedFakeSpawner = (
  spawnImpl: (
    command: ChildProcess.StandardCommand
  ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope>
): Effect.Effect<ChildProcessSpawner["Service"]> =>
  contain(
    makeSpawner((cmd) => spawnImpl(cmd as ChildProcess.StandardCommand)),
    (command, spawn) =>
      Effect.map(spawn(command), (handle) => ({
        handle,
        activate: Effect.void,
        settled: Effect.succeed(true)
      }))
  )

const fakeFsError = (method: string, reasonTag: "NotFound" | "PermissionDenied" | "Unknown" = "Unknown") =>
  PlatformError.systemError({
    _tag: reasonTag,
    module: "FileSystem",
    method,
    description: `${method} failed`
  })

/** Fake Jj that creates a workspace dir (and optionally a valid `.jj/repo` -> `store/git_target` layout). */
const makeStubJj = (
  fs: FileSystem.FileSystem,
  options?: {
    readonly gitStore?: string
    readonly commitId?: string
    readonly onAdd?: (
      name: string,
      workdir: string,
      rev?: string
    ) => Effect.Effect<void, Jj.JjFailure | PlatformError.PlatformError>
    readonly onForget?: (name: string) => Effect.Effect<void, Jj.JjFailure>
  }
): { readonly jj: Jj.Jj; readonly added: Array<string>; readonly forgotten: Array<string> } => {
  const added: Array<string> = []
  const forgotten: Array<string> = []
  const jj = Jj.makeNoop({
    snapshot: () =>
      Effect.succeed({
        commitId: options?.commitId ?? sampleSha1,
        changeId: "k".repeat(32)
      }),
    workspaceAdd: (name, workdir, rev) =>
      Effect.gen(function*() {
        if (options?.onAdd !== undefined) {
          yield* options.onAdd(name, workdir, rev)
        } else {
          yield* fs.makeDirectory(join(workdir, ".jj"), { recursive: true })
          if (options?.gitStore !== undefined) {
            const repoDir = join(options.gitStore, "..", ".jj", "repo")
            mkdirSync(join(repoDir, "store"), { recursive: true })
            mkdirSync(join(options.gitStore, "objects"), { recursive: true })
            writeFileSync(join(repoDir, "store", "git_target"), options.gitStore)
            writeFileSync(join(workdir, ".jj", "repo"), repoDir)
          }
        }
        added.push(name)
      }),
    workspaceForget: (name) =>
      Effect.gen(function*() {
        forgotten.push(name)
        if (options?.onForget !== undefined) {
          yield* options.onForget(name)
        }
      })
  })
  return { jj, added, forgotten }
}

const applyFlow = Flow.make("test/JjWorkspaceSandbox/Apply", {
  payload: SandboxMerge.Apply.payloadSchema,
  success: SandboxMerge.Outcome,
  error: SandboxMerge.Apply.errorSchema,
  body: Node.capture({ action: SandboxMerge.Apply.name }, (payload) => SandboxMerge.Apply.call(payload))
})

const mergeRuntime = Interpreter.layerWithImplementations(applyFlow, SandboxMerge.layerApply).pipe(
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(Layer.mergeAll(rawPlatform, layerRepositoryMutation, NodeCrypto.layer))
)

const durableApply = (work: Sandbox.Work, repository: string, onto: string) =>
  applyFlow.execute(
    {
      work,
      repository,
      onto,
      message: `land ${work.session}`,
      key: `application:${work.session}`
    },
    { executionId: `jj-ws-merge:${repository}:${work.session}` }
  ).pipe(Effect.provide(mergeRuntime))

describe("JjWorkspaceSandbox", () => {
  describe("construction validation and workspace naming", () => {
    it("rejects invalid workspacesRoot, network policies, limits, prefixes, and baseRevisions before touching services", () => {
      const jjU = untouchable<Jj.Jj>()
      const fsU = untouchable<FileSystem.FileSystem>()
      const pathU = untouchable<Path.Path>()
      const spawnerU = untouchable<ChildProcessSpawner["Service"]>()
      const base: JjWorkspaceSandbox.JjWorkspaceSandboxOptions = {
        jj: jjU.value,
        fs: fsU.value,
        path: pathU.value,
        spawner: spawnerU.value,
        workspacesRoot: "/tmp/valid-root"
      }

      // Invalid workspacesRoot
      for (
        const badRoot of [
          "",
          "relative/dir",
          "/tmp/a\0b",
          "/tmp/a\nb",
          "/tmp/a\rb",
          "/tmp/.git/lanes",
          "/tmp/.jj/lanes"
        ]
      ) {
        expect(() => JjWorkspaceSandbox.make({ ...base, workspacesRoot: badRoot })).toThrow(TypeError)
      }

      // Network policy
      expect(() => JjWorkspaceSandbox.make({ ...base, network: "none" })).toThrow(TypeError)
      expect(() => JjWorkspaceSandbox.make({ ...base, network: { allow: ["example.com"] } })).toThrow(TypeError)
      expect(() => JjWorkspaceSandbox.make({ ...base, network: "open" })).not.toThrow()

      // Resource limits
      expect(() => JjWorkspaceSandbox.make({ ...base, limits: { cpus: 2 } })).toThrow(TypeError)
      expect(() => JjWorkspaceSandbox.make({ ...base, limits: { memoryMib: 512 } })).toThrow(TypeError)
      expect(() => JjWorkspaceSandbox.make({ ...base, limits: { timeoutSecs: 10 } })).toThrow(TypeError)

      // Prefix validation
      for (const badPrefix of ["", "-flag", ".dot", "a/b", "has space", "a".repeat(33)]) {
        expect(() => JjWorkspaceSandbox.make({ ...base, workspacePrefix: badPrefix })).toThrow(TypeError)
        expect(() => JjWorkspaceSandbox.workspaceNameOf("s", badPrefix)).toThrow(TypeError)
      }

      // baseRevision when git is enabled (default)
      for (const badRev of ["", "@", "@-", "abcdef", "k".repeat(16), "0".repeat(40), "0".repeat(64), "-flag"]) {
        expect(() => JjWorkspaceSandbox.make({ ...base, baseRevision: badRev })).toThrow(TypeError)
      }
      expect(() => JjWorkspaceSandbox.make({ ...base, baseRevision: sampleSha1 })).not.toThrow()
      expect(() => JjWorkspaceSandbox.make({ ...base, baseRevision: sampleSha256 })).not.toThrow()

      // baseRevision when git is false
      for (const badRev of ["", "-r", "main | @", "a b", "abc\0"]) {
        expect(() => JjWorkspaceSandbox.make({ ...base, git: false, baseRevision: badRev })).toThrow(TypeError)
      }
      for (const okRev of ["@", "@-", "deadbeef", "k".repeat(12), sampleSha1]) {
        expect(() => JjWorkspaceSandbox.make({ ...base, git: false, baseRevision: okRev })).not.toThrow()
      }

      expect(jjU.touched).toEqual([])
      expect(fsU.touched).toEqual([])
      expect(pathU.touched).toEqual([])
      expect(spawnerU.touched).toEqual([])
    })

    it("derives deterministic, collision-resistant, single-segment ASCII workspace names", () => {
      expect(JjWorkspaceSandbox.workspaceNameOf("lane/one")).toBe(JjWorkspaceSandbox.workspaceNameOf("lane/one"))
      expect(JjWorkspaceSandbox.workspaceNameOf("lane/one", "Custom_")).toMatch(/^custom_[a-z0-9_-]+$/)

      const adversarial = [
        "",
        "..",
        "../../etc/passwd",
        "-rf",
        "--config=foo",
        "default",
        "a\0b",
        "lane/one",
        "lane-one",
        "lane_one",
        "Lane/one",
        `${"x".repeat(48)}1r`,
        `${"x".repeat(48)}30`,
        "a\uD800b",
        "a\uFFFDb"
      ]
      const names = adversarial.map((key) => JjWorkspaceSandbox.workspaceNameOf(key))
      expect(new Set(names).size).toBe(adversarial.length)
      for (const name of names) {
        expect(name).toMatch(/^[a-z0-9][a-z0-9_-]+$/)
        expect(name).not.toBe("default")
        expect(name.includes("/")).toBe(false)
        expect(name.includes("..")).toBe(false)
      }
    })
  })

  describe("containment, path confinement, environment scrubbing, and config safety", () => {
    it.effect("refuses raw and deadline-only spawners before touching jj or fs", () =>
      Effect.gen(function*() {
        const raw = yield* ChildProcessSpawner.pipe(Effect.provide(rawPlatform))
        const deadlineOnly = yield* contain(raw)
        for (const spawner of [raw, deadlineOnly]) {
          const jjU = untouchable<Jj.Jj>()
          const fsU = untouchable<FileSystem.FileSystem>()
          const pathU = untouchable<Path.Path>()
          const provider = JjWorkspaceSandbox.make({
            jj: jjU.value,
            fs: fsU.value,
            path: pathU.value,
            spawner,
            workspacesRoot: "/tmp/untouched"
          })
          const exit = yield* Effect.exit(Effect.scoped(provider.acquire("lane-1")))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const err = Cause.squash(exit.cause)
            expect(err).toBeInstanceOf(ProviderError)
            expect((err as ProviderError).code).toBe("unavailable")
          }
          expect(jjU.touched).toEqual([])
          expect(fsU.touched).toEqual([])
          expect(pathU.touched).toEqual([])
        }
      }))

    it.effect("refuses a Path implementation that lets a workspace escape workspacesRoot", () =>
      Effect.gen(function*() {
        const { fs, path, spawner } = yield* getPlatform
        const buggyPath: Path.Path = {
          ...path,
          relative: () => "../escaped"
        }
        const jjU = untouchable<Jj.Jj>()
        const provider = JjWorkspaceSandbox.make({
          jj: jjU.value,
          fs,
          path: buggyPath,
          spawner,
          workspacesRoot: freshDir("escape"),
          git: false
        })
        const err = yield* Effect.flip(Effect.scoped(provider.acquire("lane")))
        expect(err.code).toBe("spawn_error")
        expect(err.message).toContain("escapes workspacesRoot")
        expect(jjU.touched).toEqual([])
      }))

    it.effect("scrubs ambient credentials, GIT_DIR, and JJ_CONFIG from both session spawns and internal git calls", () =>
      Effect.gen(function*() {
        const { fs, path } = yield* getPlatform
        const root = freshDir("env-scrub")
        const gitStore = freshDir("env-git-store")
        const seenEnvs: Array<{
          readonly cmd: string
          readonly env: NonNullable<ChildProcess.CommandOptions["env"]>
        }> = []
        const spawner = yield* containedFakeSpawner((cmd) => {
          seenEnvs.push({
            cmd: cmd.command,
            env: cmd.options.env ?? {}
          })
          return Effect.succeed(makeFakeHandle())
        })
        const { jj } = makeStubJj(fs, { gitStore })
        const provider = JjWorkspaceSandbox.make({
          jj,
          fs,
          path,
          spawner,
          workspacesRoot: root,
          baseRevision: sampleSha1,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: "/home/tester",
            LC_ALL: "C.UTF-8",
            OPENAI_API_KEY: "sk-secret",
            GITHUB_TOKEN: "ghp-secret",
            GIT_DIR: "/evil/git",
            JJ_CONFIG: "/evil/jj.toml"
          }
        })

        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* provider.acquire("env-lane")
          // Internal git read-tree HEAD ran first
          expect(seenEnvs[0]?.cmd).toBe("git")
          expect(seenEnvs[0]?.env.PATH).toBe("/usr/bin:/bin")
          expect(seenEnvs[0]?.env.GIT_DIR).toBeUndefined()
          expect(seenEnvs[0]?.env.OPENAI_API_KEY).toBeUndefined()
          expect(seenEnvs[0]?.env.GITHUB_TOKEN).toBeUndefined()
          expect(seenEnvs[0]?.env.GIT_CONFIG_NOSYSTEM).toBe("1")
          expect(seenEnvs[0]?.env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
          expect(seenEnvs[0]?.env.JJ_CONFIG).toBe("/dev/null")

          // Session spawn gets scrubbed allowlist + explicit overlay + undefined deletion
          yield* session.spawn("echo ok", { env: { EXPLICIT_VAR: "1", HOME: undefined } })
          expect(seenEnvs[1]?.env.PATH).toBe("/usr/bin:/bin")
          expect(seenEnvs[1]?.env.LC_ALL).toBe("C.UTF-8")
          expect(seenEnvs[1]?.env.HOME).toBeUndefined()
          expect(seenEnvs[1]?.env.EXPLICIT_VAR).toBe("1")
          expect(seenEnvs[1]?.env.OPENAI_API_KEY).toBeUndefined()
          expect(seenEnvs[1]?.env.GIT_DIR).toBeUndefined()
          expect(seenEnvs[1]?.env.JJ_CONFIG).toBeUndefined()

          // Unusable env name fails closed
          const badEnv = yield* Effect.flip(session.spawn("echo ok", { env: { "bad-name": "1" } }))
          expect(badEnv.code).toBe("spawn_error")
        }))

        // Omitting `env` starts commands with an empty base environment (zero ambient reads)
        const emptyProvider = JjWorkspaceSandbox.make({
          jj,
          fs,
          path,
          spawner,
          workspacesRoot: freshDir("env-empty"),
          git: false
        })
        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* emptyProvider.acquire("empty-env-lane")
          yield* session.spawn("echo ok", {})
          const last = seenEnvs[seenEnvs.length - 1]!
          expect(Object.keys(last.env)).toEqual([])
        }))
      }))

    it.effect("rejects unmigrated .jj/workspace-config.toml and allows migrated workspace-config-id", () =>
      Effect.gen(function*() {
        const { fs, path, spawner } = yield* getPlatform
        const root = freshDir("ws-config")
        let includeId = false
        const { jj, forgotten } = makeStubJj(fs, {
          onAdd: (_name, workdir) =>
            Effect.sync(() => {
              mkdirSync(join(workdir, ".jj"), { recursive: true })
              writeFileSync(join(workdir, ".jj", "workspace-config.toml"), "[user]\nname = \"evil\"\n")
              if (includeId) writeFileSync(join(workdir, ".jj", "workspace-config-id"), "trusted-id\n")
            })
        })
        const provider = JjWorkspaceSandbox.make({
          jj,
          fs,
          path,
          spawner,
          workspacesRoot: root,
          git: false
        })

        // Unmigrated config is refused AND rolled back immediately inside a long-lived scope
        const outerScope = yield* Scope.make()
        const err = yield* Effect.flip(provider.acquire("planted").pipe(Scope.provide(outerScope)))
        expect(err.code).toBe("unavailable")
        expect(err.message).toContain("workspace-config.toml")
        const wsName = JjWorkspaceSandbox.workspaceNameOf("planted")
        expect(forgotten).toEqual([wsName])
        expect(existsSync(join(root, wsName))).toBe(false)
        // Closing outer scope afterwards is double-release idempotent
        yield* Scope.close(outerScope, Exit.void)
        expect(forgotten).toEqual([wsName])

        // Migrated config (with workspace-config-id) is accepted
        includeId = true
        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* provider.acquire("trusted")
          yield* session.ping!
        }))
      }))
  })

  describe("private git view setup, SHA-256 support, and fault rollback", () => {
    it.effect("writes SHA-256 config for 64-char baseRevision and rolls back on gitView errors", () =>
      Effect.gen(function*() {
        const { fs, path } = yield* getPlatform
        const gitStore = freshDir("sha256-store")
        let gitExitCode = 0
        let failGitSpawn = false
        const spawner = yield* containedFakeSpawner(() =>
          failGitSpawn
            ? Effect.fail(fakeFsError("spawn"))
            : Effect.succeed(makeFakeHandle({ exitCode: gitExitCode, stderr: "fatal: bad object\n" }))
        )

        // 1. SHA-256 64-char baseRevision succeeds and writes format version 1 + sha256
        const root1 = freshDir("sha256-root")
        const stub1 = makeStubJj(fs, { gitStore })
        const provider1 = JjWorkspaceSandbox.make({
          jj: stub1.jj,
          fs,
          path,
          spawner,
          workspacesRoot: root1,
          baseRevision: sampleSha256
        })
        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* provider1.acquire("sha256-lane")
          const configText = readFileSync(join(session.workdir, ".git", "config"), "utf8")
          expect(configText).toContain("repositoryformatversion = 1")
          expect(configText).toContain("objectformat = sha256")
          expect(readFileSync(join(session.workdir, ".git", "HEAD"), "utf8")).toBe(`${sampleSha256}\n`)
          expect(readFileSync(join(session.workdir, ".jj", ".gitignore"), "utf8")).toBe("*\n")
        }))

        // 2. Non-zero git read-tree HEAD rolls back
        gitExitCode = 128
        const errExit = yield* Effect.flip(Effect.scoped(provider1.acquire("git-nonzero")))
        expect(errExit.code).toBe("unavailable")
        expect(errExit.message).toContain("exited 128")
        expect(stub1.forgotten).toContain(JjWorkspaceSandbox.workspaceNameOf("git-nonzero"))

        // 3. git spawn failure rolls back
        gitExitCode = 0
        failGitSpawn = true
        const errSpawn = yield* Effect.flip(Effect.scoped(provider1.acquire("git-spawn-fail")))
        expect(errSpawn.code).toBe("unavailable")
        expect(errSpawn.message).toContain("could not start")
        failGitSpawn = false

        // 4. Missing .jj/repo fails with helpful message and rolls back
        const stubNoGit = makeStubJj(fs)
        const providerNoGit = JjWorkspaceSandbox.make({
          jj: stubNoGit.jj,
          fs,
          path,
          spawner,
          workspacesRoot: freshDir("no-git"),
          baseRevision: sampleSha1
        })
        const errNoGit = yield* Effect.flip(Effect.scoped(providerNoGit.acquire("no-git-lane")))
        expect(errNoGit.code).toBe("unavailable")
        expect(errNoGit.message).toContain("git: false")
        expect(stubNoGit.forgotten).toContain(JjWorkspaceSandbox.workspaceNameOf("no-git-lane"))

        // 5. Invalid objectsDir containing newline fails and rolls back
        const badRealPathFs: FileSystem.FileSystem = {
          ...fs,
          realPath: () => Effect.succeed("/tmp/evil\npath/objects")
        }
        const providerBadObj = JjWorkspaceSandbox.make({
          jj: stub1.jj,
          fs: badRealPathFs,
          path,
          spawner,
          workspacesRoot: freshDir("bad-obj"),
          baseRevision: sampleSha1
        })
        const errBadObj = yield* Effect.flip(Effect.scoped(providerBadObj.acquire("bad-obj-lane")))
        expect(errBadObj.code).toBe("unavailable")
        expect(errBadObj.message).toContain("invalid git object directory")

        // 6. Snapshot returning non-material commit id (all zeros) fails before workspaceAdd
        const stubZeroSnap = makeStubJj(fs, { gitStore, commitId: "0".repeat(40) })
        const providerZeroSnap = JjWorkspaceSandbox.make({
          jj: stubZeroSnap.jj,
          fs,
          path,
          spawner,
          workspacesRoot: freshDir("zero-snap")
        })
        const errZero = yield* Effect.flip(Effect.scoped(providerZeroSnap.acquire("zero-lane")))
        expect(errZero.code).toBe("unavailable")
        expect(errZero.message).toContain("non-material commit id")
        expect(stubZeroSnap.added).toEqual([])
      }))
  })

  describe("lifecycle, concurrency, rollback, error aggregation, and session methods", () => {
    it.effect("enforces ephemeral single-holder exclusivity and serializes jj mutations via jjGate", () =>
      Effect.gen(function*() {
        const { fs, path, spawner } = yield* getPlatform
        const root = freshDir("exclusivity")
        let inFlight = 0
        let maxInFlight = 0
        const firstEntered = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const { jj } = makeStubJj(fs, {
          onAdd: (_name, workdir) =>
            Effect.gen(function*() {
              inFlight += 1
              maxInFlight = Math.max(maxInFlight, inFlight)
              if (inFlight === 1 && !existsSync(join(root, "first-done"))) {
                yield* Deferred.succeed(firstEntered, undefined)
                yield* Deferred.await(releaseFirst)
                writeFileSync(join(root, "first-done"), "1")
              }
              yield* fs.makeDirectory(workdir, { recursive: true })
              inFlight -= 1
            })
        })
        const provider = JjWorkspaceSandbox.make({
          jj,
          fs,
          path,
          spawner,
          workspacesRoot: root,
          git: false
        })

        // Start lane-a, wait until it enters jj.workspaceAdd, then try concurrent lane-a (refused) and lane-b (serialized)
        const fiberA = yield* Effect.forkChild(Effect.scoped(provider.acquire("lane-a")))
        yield* Deferred.await(firstEntered)
        const dupErr = yield* Effect.flip(Effect.scoped(provider.acquire("lane-a")))
        expect(dupErr.code).toBe("unavailable")
        expect(dupErr.message).toContain("already held")

        const fiberB = yield* Effect.forkChild(Effect.scoped(provider.acquire("lane-b")))
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(fiberA)
        yield* Fiber.join(fiberB)
        expect(maxInFlight).toBe(1)
      }))

    it.effect("handles pre-creation vs ambiguous workspaceAdd failures, interrupts, and existedBefore preservation", () =>
      Effect.gen(function*() {
        const { fs, path, spawner } = yield* getPlatform
        const root = freshDir("rollback-cases")
        const teardownReports: Array<JjWorkspaceSandbox.TeardownFailure> = []

        // 1. Pre-creation JjError vs ambiguous JjError codes
        for (
          const [code, expectedProviderCode] of [
            ["not_installed", "unavailable"],
            ["unsupported_version", "unavailable"],
            ["stale_workspace", "unavailable"],
            ["invalid_ref", "spawn_error"],
            ["conflict", "spawn_error"],
            ["snapshot_refused", "unknown"],
            ["unknown", "unknown"]
          ] as const
        ) {
          const forgotten: Array<string> = []
          const jj = Jj.makeNoop({
            workspaceAdd: (_name, workdir) =>
              Effect.gen(function*() {
                yield* fs.makeDirectory(workdir, { recursive: true })
                return yield* Jj.jjError({ code, method: "workspaceAdd", description: code })
              }),
            workspaceForget: (name) =>
              Effect.sync(() => {
                forgotten.push(name)
              })
          })
          const provider = JjWorkspaceSandbox.make({
            jj,
            fs,
            path,
            spawner,
            workspacesRoot: root,
            git: false,
            onTeardownFailure: (f) =>
              Effect.sync(() => {
                teardownReports.push(f)
              })
          })
          const key = `err-${code}`
          const ws = JjWorkspaceSandbox.workspaceNameOf(key)
          const err = yield* Effect.flip(Effect.scoped(provider.acquire(key)))
          expect(err.code).toBe(expectedProviderCode)
          expect(existsSync(join(root, ws))).toBe(false)
          if (
            code === "not_installed" || code === "unsupported_version" || code === "conflict" || code === "invalid_ref"
          ) {
            expect(forgotten).toEqual([])
          } else {
            expect(forgotten).toEqual([ws])
          }
        }

        // 2. PermissionDenied (pre-creation, no dir created) skips forget and remove
        {
          const forgotten: Array<string> = []
          const jj = Jj.makeNoop({
            workspaceAdd: () =>
              Effect.fail(Permission.permissionDenied(Capability.make("jj:workspace-add", root), "denied")),
            workspaceForget: (name) =>
              Effect.sync(() => {
                forgotten.push(name)
              })
          })
          const provider = JjWorkspaceSandbox.make({ jj, fs, path, spawner, workspacesRoot: root, git: false })
          const err = yield* Effect.flip(Effect.scoped(provider.acquire("perm-denied")))
          expect(err.code).toBe("unavailable")
          expect(forgotten).toEqual([])
        }

        // 3. PlatformError during workspaceAdd runs full forget + remove and reports rollback errors without masking
        {
          const reports: Array<JjWorkspaceSandbox.TeardownFailure> = []
          const jj = Jj.makeNoop({
            workspaceAdd: () => Effect.fail(fakeFsError("workspaceAdd")),
            workspaceForget: () =>
              Effect.fail(Jj.jjError({ code: "unknown", method: "workspaceForget", description: "forget boom" }))
          })
          const flakyFs: FileSystem.FileSystem = {
            ...fs,
            remove: () => Effect.fail(fakeFsError("remove"))
          }
          const provider = JjWorkspaceSandbox.make({
            jj,
            fs: flakyFs,
            path,
            spawner,
            workspacesRoot: root,
            git: false,
            onTeardownFailure: (f) =>
              Effect.sync(() => {
                reports.push(f)
              })
          })
          const err = yield* Effect.flip(Effect.scoped(provider.acquire("plat-err")))
          expect(err.code).toBe("unavailable")
          expect(reports.map((r) => r.step)).toEqual(["forget", "remove"])
        }

        // 4. Pre-creation rollback where fs.exists or fs.remove fails reports via onTeardownFailure
        {
          const reports: Array<JjWorkspaceSandbox.TeardownFailure> = []
          let existsCalls = 0
          const flakyFs: FileSystem.FileSystem = {
            ...fs,
            exists: () => {
              existsCalls += 1
              return existsCalls === 1 ? Effect.succeed(false) : Effect.fail(fakeFsError("exists"))
            }
          }
          const jj = Jj.makeNoop({
            workspaceAdd: () =>
              Effect.fail(Jj.jjError({ code: "conflict", method: "workspaceAdd", description: "dup" }))
          })
          const provider = JjWorkspaceSandbox.make({
            jj,
            fs: flakyFs,
            path,
            spawner,
            workspacesRoot: root,
            git: false,
            onTeardownFailure: (f) =>
              Effect.sync(() => {
                reports.push(f)
              })
          })
          const err = yield* Effect.flip(Effect.scoped(provider.acquire("pre-exists-fail")))
          expect(err.code).toBe("spawn_error")
          expect(reports.map((r) => r.step)).toEqual(["remove"])

          // Also cover pre-creation where exists=true and remove fails
          const reports2: Array<JjWorkspaceSandbox.TeardownFailure> = []
          let existsCalls2 = 0
          const flakyFs2: FileSystem.FileSystem = {
            ...fs,
            exists: () => {
              existsCalls2 += 1
              return Effect.succeed(existsCalls2 > 1)
            },
            remove: () => Effect.fail(fakeFsError("remove"))
          }
          const provider2 = JjWorkspaceSandbox.make({
            jj,
            fs: flakyFs2,
            path,
            spawner,
            workspacesRoot: root,
            git: false,
            onTeardownFailure: (f) =>
              Effect.sync(() => {
                reports2.push(f)
              })
          })
          const err2 = yield* Effect.flip(Effect.scoped(provider2.acquire("pre-remove-fail")))
          expect(err2.code).toBe("spawn_error")
          expect(reports2.map((r) => r.step)).toEqual(["remove"])
        }

        // 5. existedBefore === true: failed workspaceAdd does NOT forget or remove pre-existing workspace
        {
          const existingKey = "pre-existing"
          const ws = JjWorkspaceSandbox.workspaceNameOf(existingKey)
          mkdirSync(join(root, ws), { recursive: true })
          writeFileSync(join(root, ws, "keep.txt"), "precious")
          const forgotten: Array<string> = []
          const jj = Jj.makeNoop({
            workspaceAdd: () =>
              Effect.fail(Jj.jjError({ code: "unknown", method: "workspaceAdd", description: "exists" })),
            workspaceForget: (name) =>
              Effect.sync(() => {
                forgotten.push(name)
              })
          })
          const provider = JjWorkspaceSandbox.make({ jj, fs, path, spawner, workspacesRoot: root, git: false })
          const err = yield* Effect.flip(Effect.scoped(provider.acquire(existingKey)))
          expect(err.code).toBe("unknown")
          expect(forgotten).toEqual([])
          expect(readFileSync(join(root, ws, "keep.txt"), "utf8")).toBe("precious")
        }

        // 6. Interruption during workspaceAdd runs forget + remove uninterruptibly
        {
          const started = yield* Deferred.make<void>()
          const forgotten: Array<string> = []
          const jj = Jj.makeNoop({
            workspaceAdd: (_name, workdir) =>
              Effect.gen(function*() {
                yield* fs.makeDirectory(workdir, { recursive: true })
                yield* Deferred.succeed(started, undefined)
                return yield* Effect.never
              }),
            workspaceForget: (name) =>
              Effect.sync(() => {
                forgotten.push(name)
              })
          })
          const provider = JjWorkspaceSandbox.make({ jj, fs, path, spawner, workspacesRoot: root, git: false })
          const key = "interrupted-add"
          const ws = JjWorkspaceSandbox.workspaceNameOf(key)
          const fiber = yield* Effect.forkChild(Effect.scoped(provider.acquire(key)))
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(forgotten).toEqual([ws])
          expect(existsSync(join(root, ws))).toBe(false)
        }
      }))

    it.effect("orders teardown (kill -> forget -> remove), aggregates non-masking errors, and enforces post-release guards", () =>
      Effect.gen(function*() {
        const { fs, path } = yield* getPlatform
        const root = freshDir("ordered-teardown")
        const events: Array<string> = []
        let failKill = false
        let failForget = false
        let failRemove = false

        const spawner = yield* containedFakeSpawner(() =>
          Effect.succeed(
            makeFakeHandle({
              onKill: (sig) => {
                events.push(`kill:${sig}`)
                return failKill ? Effect.fail(fakeFsError("kill")) : Effect.void
              }
            })
          )
        )
        const { jj } = makeStubJj(fs, {
          onForget: (name) => {
            events.push(`forget:${name}`)
            return failForget
              ? Effect.fail(Jj.jjError({ code: "unknown", method: "workspaceForget", description: "forget failed" }))
              : Effect.void
          }
        })
        const trackedFs: FileSystem.FileSystem = {
          ...fs,
          remove: (p, opts) => {
            events.push(`remove:${p}`)
            return failRemove ? Effect.fail(fakeFsError("remove")) : fs.remove(p, opts)
          }
        }

        // 1. Outer-scoped spawn outlives session scope -> killed BEFORE forget BEFORE remove
        const reports: Array<JjWorkspaceSandbox.TeardownFailure> = []
        const provider = JjWorkspaceSandbox.make({
          jj,
          fs: trackedFs,
          path,
          spawner,
          workspacesRoot: root,
          git: false,
          onTeardownFailure: (f) =>
            Effect.sync(() => {
              reports.push(f)
            })
        })

        let leakedSession!: Sandbox.Session
        const outerSpawnScope = yield* Scope.make()
        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* provider.acquire("ordered")
          leakedSession = session
          // Spawn inside outer scope so session closes first
          yield* session.spawn("sleep 60", {}).pipe(Scope.provide(outerSpawnScope))
        }))
        const ws = JjWorkspaceSandbox.workspaceNameOf("ordered")
        expect(events).toEqual([`kill:SIGTERM`, `forget:${ws}`, `remove:${join(root, ws)}`])
        // Closing outer spawn scope later sees handle was already deleted -> no duplicate kill
        yield* Scope.close(outerSpawnScope, Exit.void)
        expect(events.length).toBe(3)

        // Post-release guards on leakedSession
        expect((yield* Effect.flip(Effect.scoped(leakedSession.spawn("echo hi", {})))).code).toBe("unavailable")
        expect((yield* Effect.flip(leakedSession.ping!)).code).toBe("unavailable")
        expect((yield* Effect.flip(Effect.scoped(leakedSession.fork!("child")))).code).toBe("unavailable")

        // 2. Forget + remove failures both run and report without turning finished scope into defect (also test default logger)
        failForget = true
        failRemove = true
        const defaultLogProvider = JjWorkspaceSandbox.make({
          jj,
          fs: trackedFs,
          path,
          spawner,
          workspacesRoot: freshDir("default-log"),
          git: false
        })
        yield* Effect.scoped(defaultLogProvider.acquire("log-both"))
        yield* Effect.scoped(provider.acquire("report-both"))
        expect(reports.map((r) => r.step)).toEqual(["forget", "remove"])

        // 3. Kill failure during session teardown runs forget+remove, reports all, AND dies with ProviderError
        failKill = true
        failForget = false
        failRemove = false
        reports.length = 0
        const outerKillScope = yield* Scope.make()
        const killExit = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
          const session = yield* provider.acquire("kill-fail")
          yield* session.spawn("sleep 60", {}).pipe(Scope.provide(outerKillScope))
        })))
        yield* Scope.close(outerKillScope, Exit.void)
        expect(Exit.isFailure(killExit)).toBe(true)
        if (Exit.isFailure(killExit)) {
          expect(Cause.hasDies(killExit.cause)).toBe(true)
        }
        expect(reports.map((r) => r.step)).toEqual(["kill"])
      }))

    it.effect("covers session readFile, writeFile, kill, ping, spawn, and root/exists error paths", () =>
      Effect.gen(function*() {
        const { fs, path } = yield* getPlatform
        const root = freshDir("session-errors")
        let failSpawn = false
        let failRead = false
        let failWrite = false
        let failPingExists = false
        let failRootMkdir = false
        let failWorkdirExists = false

        const spawner = yield* containedFakeSpawner(() =>
          failSpawn ? Effect.fail(fakeFsError("spawn")) : Effect.succeed(makeFakeHandle())
        )
        const { jj } = makeStubJj(fs)
        const faultFs: FileSystem.FileSystem = {
          ...fs,
          makeDirectory: (p, opts) =>
            failRootMkdir && p === root ? Effect.fail(fakeFsError("makeDirectory")) : fs.makeDirectory(p, opts),
          exists: (p) => failWorkdirExists || failPingExists ? Effect.fail(fakeFsError("exists")) : fs.exists(p),
          readFile: (p) => failRead ? Effect.fail(fakeFsError("readFile", "PermissionDenied")) : fs.readFile(p),
          writeFile: (p, data) =>
            failWrite ? Effect.fail(fakeFsError("writeFile", "PermissionDenied")) : fs.writeFile(p, data)
        }
        const provider = JjWorkspaceSandbox.make({
          jj,
          fs: faultFs,
          path,
          spawner,
          workspacesRoot: root,
          git: false
        })

        // Root mkdir failure
        failRootMkdir = true
        expect((yield* Effect.flip(Effect.scoped(provider.acquire("root-fail")))).code).toBe("unavailable")
        failRootMkdir = false

        // Workdir exists failure
        failWorkdirExists = true
        expect((yield* Effect.flip(Effect.scoped(provider.acquire("exists-fail")))).code).toBe("unavailable")
        failWorkdirExists = false

        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* provider.acquire("ops-lane")
          // readFile not_found vs unknown
          expect((yield* Effect.flip(session.readFile(join(session.workdir, "missing.txt")))).code).toBe("not_found")
          failRead = true
          expect((yield* Effect.flip(session.readFile(join(session.workdir, "missing.txt")))).code).toBe("unknown")
          failRead = false

          // writeFile failure
          failWrite = true
          expect((yield* Effect.flip(session.writeFile(join(session.workdir, "a.txt"), new Uint8Array([1])))).code)
            .toBe(
              "unknown"
            )
          failWrite = false

          // spawn failure
          failSpawn = true
          expect((yield* Effect.flip(Effect.scoped(session.spawn("echo hi", {})))).code).toBe("spawn_error")
          failSpawn = false

          // kill unrecognized process
          const foreign = {
            stdout: Stream.empty,
            stderr: Stream.empty,
            exitCode: Effect.succeed(0)
          }
          expect((yield* Effect.flip(session.kill!(foreign, "SIGTERM"))).code).toBe("unknown")

          // ping fs error and absent directory
          failPingExists = true
          expect((yield* Effect.flip(session.ping!)).code).toBe("unavailable")
          failPingExists = false
          rmSync(session.workdir, { recursive: true, force: true })
          expect((yield* Effect.flip(session.ping!)).code).toBe("unavailable")
        }))
      }))
  })

  describe("sticky persistence (retained, attach, idempotent destroy)", () => {
    it.effect("retains workspace across scopes, supports attach and re-acquire, and destroys idempotently with full error reporting", () =>
      Effect.gen(function*() {
        const { fs, path } = yield* getPlatform
        const root = freshDir("sticky-root")
        let failKill = false
        let forgetMode: "ok" | "invalid_ref" | "fail" = "ok"
        let failRemove = false
        let failAttachExists = false
        let killCount = 0

        const spawner = yield* containedFakeSpawner(() =>
          Effect.succeed(
            makeFakeHandle({
              onKill: () => {
                killCount += 1
                return failKill ? Effect.fail(fakeFsError("kill")) : Effect.void
              }
            })
          )
        )
        const { jj, added, forgotten } = makeStubJj(fs, {
          onForget: () =>
            forgetMode === "invalid_ref"
              ? Effect.fail(Jj.jjError({ code: "invalid_ref", method: "workspaceForget", description: "already gone" }))
              : forgetMode === "fail"
              ? Effect.fail(Jj.jjError({ code: "unknown", method: "workspaceForget", description: "forget error" }))
              : Effect.void
        })
        const faultFs: FileSystem.FileSystem = {
          ...fs,
          exists: (p) => failAttachExists ? Effect.fail(fakeFsError("exists")) : fs.exists(p),
          remove: (p, opts) => failRemove ? Effect.fail(fakeFsError("remove")) : fs.remove(p, opts)
        }
        const provider = JjWorkspaceSandbox.make({
          jj,
          fs: faultFs,
          path,
          spawner,
          workspacesRoot: root,
          git: false,
          persistence: "sticky"
        })

        expect(provider.retained).toBe(true)
        expect(provider.attach).toBeDefined()
        expect(provider.destroy).toBeDefined()

        // Identity mismatch refused on attach and destroy
        expect((yield* Effect.flip(Effect.scoped(provider.attach!({ id: "s1", remoteId: "wrong" })))).code).toBe(
          "spawn_error"
        )
        expect((yield* Effect.flip(provider.destroy!({ id: "s1", remoteId: "wrong" }))).code).toBe("spawn_error")

        const ws = JjWorkspaceSandbox.workspaceNameOf("s1")
        // Attach on absent workspace -> not_found; attach exists error -> unavailable
        expect((yield* Effect.flip(Effect.scoped(provider.attach!({ id: "s1", remoteId: ws })))).code).toBe("not_found")
        failAttachExists = true
        expect((yield* Effect.flip(Effect.scoped(provider.attach!({ id: "s1", remoteId: ws })))).code).toBe(
          "unavailable"
        )
        failAttachExists = false

        // Acquire, write a file, close scope -> file survives on disk
        let saved!: Pick<Sandbox.Session, "id" | "remoteId">
        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* provider.acquire("s1")
          saved = { id: session.id, remoteId: session.remoteId }
          yield* session.writeFile(join(session.workdir, "persisted.txt"), new TextEncoder().encode("alive"))
        }))
        expect(added).toEqual([ws])
        expect(forgotten).toEqual([])
        expect(existsSync(join(root, ws, "persisted.txt"))).toBe(true)

        // Re-acquiring existing sticky workspace reuses it without calling workspaceAdd again
        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* provider.acquire("s1")
          const data = yield* session.readFile(join(session.workdir, "persisted.txt"))
          expect(new TextDecoder().decode(data)).toBe("alive")
        }))
        expect(added).toEqual([ws])

        // Attach from two concurrent scopes (covers multi-lane tracking & group.size > 0 on untrack)
        const liveScope1 = yield* Scope.make()
        const liveScope2 = yield* Scope.make()
        const liveSession1 = yield* provider.attach!(saved).pipe(Scope.provide(liveScope1))
        yield* provider.attach!(saved).pipe(Scope.provide(liveScope2))
        yield* Scope.close(liveScope2, Exit.void)
        yield* liveSession1.spawn("sleep 60", {}).pipe(Scope.provide(liveScope1))

        // First test destroy when kill, forget, and remove all fail -> reports all steps with code "unknown"
        failKill = true
        forgetMode = "fail"
        failRemove = true
        const destroyErr1 = yield* Effect.flip(provider.destroy!(saved))
        expect(destroyErr1.code).toBe("unknown")
        expect(destroyErr1.message).toContain("kill, forget, remove")
        yield* Scope.close(liveScope1, Exit.void)

        // Next test destroy when forget + remove fail (no kill failure) -> code "unavailable"
        failKill = false
        const destroyErr2 = yield* Effect.flip(provider.destroy!(saved))
        expect(destroyErr2.code).toBe("unavailable")
        expect(destroyErr2.message).toContain("forget, remove")

        // Now succeed, then repeat destroy with invalid_ref -> idempotent!
        forgetMode = "ok"
        failRemove = false
        yield* provider.destroy!(saved)
        expect(existsSync(join(root, ws))).toBe(false)
        expect(killCount).toBeGreaterThan(0)

        forgetMode = "invalid_ref"
        yield* provider.destroy!(saved)

        // Post-add failure in sticky mode (e.g. fork copy fails) STILL removes half-created child workspace!
        const badForkProvider = JjWorkspaceSandbox.make({
          jj,
          fs: {
            ...fs,
            readDirectory: () => Effect.fail(fakeFsError("readDirectory"))
          },
          path,
          spawner,
          workspacesRoot: root,
          git: false,
          persistence: "sticky"
        })
        const forkErr = yield* Effect.flip(Effect.scoped(Effect.gen(function*() {
          const parent = yield* badForkProvider.acquire("sticky-parent")
          yield* parent.fork!("sticky-child")
        })))
        expect(forkErr.code).toBe("unavailable")
        expect(existsSync(join(root, JjWorkspaceSandbox.workspaceNameOf("sticky-child")))).toBe(false)
        yield* badForkProvider.destroy!({
          id: "sticky-parent",
          remoteId: JjWorkspaceSandbox.workspaceNameOf("sticky-parent")
        })

        // Race: sticky destroy invoked while an acquire is mid-workspaceAdd and then fails
        const addStarted = yield* Deferred.make<void>()
        const failAdd = yield* Deferred.make<void>()
        const racingJj = Jj.makeNoop({
          workspaceAdd: () =>
            Effect.gen(function*() {
              yield* Deferred.succeed(addStarted, undefined)
              yield* Deferred.await(failAdd)
              return yield* Jj.jjError({ code: "conflict", method: "workspaceAdd", description: "raced" })
            }),
          workspaceForget: () => Effect.void
        })
        const racingProvider = JjWorkspaceSandbox.make({
          jj: racingJj,
          fs,
          path,
          spawner,
          workspacesRoot: root,
          git: false,
          persistence: "sticky"
        })
        const raceKey = "sticky-race"
        const raceWs = JjWorkspaceSandbox.workspaceNameOf(raceKey)
        const acquireFiber = yield* Effect.forkChild(Effect.scoped(racingProvider.acquire(raceKey)))
        yield* Deferred.await(addStarted)
        const destroyFiber = yield* Effect.forkChild(racingProvider.destroy!({ id: raceKey, remoteId: raceWs }))
        yield* Effect.yieldNow
        yield* Deferred.succeed(failAdd, undefined)
        const acquireExit = yield* Fiber.await(acquireFiber)
        expect(Exit.isFailure(acquireExit)).toBe(true)
        yield* Fiber.join(destroyFiber)
      }))
  })

  describe("browser and Worker bundleability", () => {
    it("bundles for browser/Worker targets with zero node:/bun: imports or ambient process reads", async () => {
      const entry = fileURLToPath(new URL("../src/JjWorkspaceSandbox/index.ts", import.meta.url))
      const bundled = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        metafile: true,
        format: "esm",
        platform: "browser",
        target: "es2022"
      })
      expect(bundled.errors).toEqual([])
      expect(bundled.outputFiles.length).toBe(1)
      const inputs = Object.keys(bundled.metafile.inputs)
      expect(inputs.some((input) => input.startsWith("node:") || input.startsWith("bun:"))).toBe(false)

      // Strip comments and types from our own module graph (excluding external packages)
      const ownCode = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        packages: "external",
        format: "esm",
        platform: "browser",
        target: "es2022",
        legalComments: "none"
      })
      expect(ownCode.errors).toEqual([])
      const emitted = ownCode.outputFiles[0]!.text
      expect(emitted).not.toMatch(/["'](?:node|bun):/)
      expect(emitted).not.toContain("globalThis.process")
      expect(emitted).not.toMatch(/\bprocess\.env\b/)
      expect(emitted).not.toMatch(/\bBun\b|\bDeno\b/)
    })
  })

  describe("real NodeJj conformance, Sandbox.run, SandboxMerge.Apply, and fork", () => {
    it.effect("passes SandboxConformance.check over a real NodeJj repository", () =>
      Effect.gen(function*() {
        const repoRoot = freshDir("conformance-repo")
        const { path: repoPath, main } = hostRepository(repoRoot, { "README.md": "hello\n" })
        const workspacesRoot = freshDir("conformance-ws")
        const { fs, path, spawner } = yield* getPlatform
        const jj = yield* Jj.Jj.pipe(Effect.provide(layerAt(repoPath)))
        const provider = JjWorkspaceSandbox.make({
          jj,
          fs,
          path,
          spawner,
          workspacesRoot,
          baseRevision: main,
          env: process.env
        })
        const seed = makeWorkSeed()
        const violations = yield* SandboxConformance.check(provider, {
          session: "jj-conformance-lane",
          provides: { kill: true, ping: true, interrupt: true, ephemeral: true },
          commands: { ...SandboxConformance.uniquePosixCommands(), stopsWithin: "15 seconds" },
          checkTimeout: "30 seconds",
          work: seed
        })
        expect(violations).toEqual([])
      }), slow)

    it.effect(
      "runs stock Sandbox.run + durable SandboxMerge.Apply across colocated, non-colocated, binary, and parallel lanes",
      () =>
        Effect.gen(function*() {
          const { fs, path, spawner } = yield* getPlatform

          // 1. Colocated repository with uncommitted wip.txt and a root .gitignore that tries to un-ignore `.jj`
          const colocatedRoot = freshDir("colocated")
          const { path: repoPath, main } = hostRepository(colocatedRoot, {
            "a.txt": "alpha\n",
            "b.txt": "beta\n",
            "shared.txt": "line1\n",
            "rename-me.txt": "move me\n",
            ".gitignore": "!.jj/**\n!.jj/\n"
          })
          // Uncommitted edit in host working copy
          writeFileSync(join(repoPath, "wip.txt"), "host uncommitted\n")
          const jj = yield* Jj.Jj.pipe(Effect.provide(layerAt(repoPath)))
          const workspacesRoot = freshDir("colocated-ws")
          const provider = JjWorkspaceSandbox.make({
            jj,
            fs,
            path,
            spawner,
            workspacesRoot,
            env: process.env
          })

          // Omitted baseRevision snapshots host working copy (wip.txt is present in lane and NOT in Work patch!)
          const binaryBytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 99])
          const { work: snapWork } = yield* Sandbox.run(
            provider,
            { session: "snap-binary-lane" },
            Effect.gen(function*() {
              const laneFs = yield* FileSystem.FileSystem
              const laneSpawner = yield* ChildProcessSpawner
              // Host wip.txt is in the lane
              expect(yield* laneFs.readFileString("wip.txt")).toBe("host uncommitted\n")
              // Lane-local git branch must NOT mutate host refs!
              yield* laneSpawner.string(ChildProcess.make("sh", ["-c", "git checkout -q -b lane-local-branch"]))
              // Write binary + rename + edit
              yield* laneFs.writeFile("bin.dat", binaryBytes)
              yield* laneFs.rename("rename-me.txt", "renamed.txt")
              yield* laneFs.writeFileString("a.txt", "alpha-updated\n")
            })
          )
          expect(snapWork._tag).toBe("Changed")
          if (snapWork._tag === "Changed") {
            expect(snapWork.patch).not.toContain(".jj/")
            expect(snapWork.patch).not.toContain("wip.txt")
            expect(snapWork.patch).toContain("GIT binary patch")
            expect(snapWork.patch).toContain("rename from rename-me.txt")
          }
          // Host repository has NO `lane-local-branch` ref!
          const hostBranches = host(repoPath, "git branch --list lane-local-branch").trim()
          expect(hostBranches).toBe("")
          // Workspace was forgotten and removed on scope exit
          expect(host(repoPath, "jj --ignore-working-copy workspace list")).not.toContain(
            JjWorkspaceSandbox.workspaceNameOf("snap-binary-lane")
          )
          expect(existsSync(join(workspacesRoot, JjWorkspaceSandbox.workspaceNameOf("snap-binary-lane")))).toBe(false)

          // Land binary work through durable SandboxMerge.Apply
          const snapOutcome = yield* durableApply(snapWork, repoPath, main)
          expect(snapOutcome._tag).toBe("Merged")
          if (snapOutcome._tag === "Merged") {
            const landedBin = host(
              repoPath,
              `git show ${snapOutcome.commit}:bin.dat | od -An -tx1 | tr -d ' \\n'`
            )
            expect(landedBin).toBe(Array.from(binaryBytes, (b) => b.toString(16).padStart(2, "0")).join(""))
          }

          // 2. Three parallel lanes pinned at `main`: two disjoint merge cleanly, third overlapping conflicts
          const pinnedProvider = JjWorkspaceSandbox.make({
            jj,
            fs,
            path,
            spawner,
            workspacesRoot,
            baseRevision: main,
            env: process.env
          })
          const [lane1, lane2, lane3] = yield* Effect.all(
            [
              Sandbox.run(
                pinnedProvider,
                { session: "parallel-1" },
                Effect.flatMap(FileSystem.FileSystem, (laneFs) => laneFs.writeFileString("a.txt", "from-lane-1\n"))
              ),
              Sandbox.run(
                pinnedProvider,
                { session: "parallel-2" },
                Effect.flatMap(FileSystem.FileSystem, (laneFs) =>
                  Effect.andThen(
                    laneFs.writeFileString("b.txt", "from-lane-2\n"),
                    laneFs.writeFileString("shared.txt", "lane-2-edit\n")
                  ))
              ),
              Sandbox.run(
                pinnedProvider,
                { session: "parallel-3" },
                Effect.flatMap(FileSystem.FileSystem, (laneFs) => laneFs.writeFileString("shared.txt", "lane-3-edit\n"))
              )
            ],
            { concurrency: "unbounded" }
          )
          const outcome1 = yield* durableApply(lane1.work, repoPath, main)
          expect(outcome1._tag).toBe("Merged")
          if (outcome1._tag !== "Merged") return
          const outcome2 = yield* durableApply(lane2.work, repoPath, outcome1.commit)
          expect(outcome2._tag).toBe("Merged")
          if (outcome2._tag !== "Merged") return
          const outcome3 = yield* durableApply(lane3.work, repoPath, outcome2.commit)
          expect(outcome3._tag).toBe("Conflicted")
          if (outcome3._tag === "Conflicted") {
            expect(outcome3.paths).toEqual(["shared.txt"])
          }

          // 3. Non-colocated jj repository works identically with Sandbox.run + SandboxMerge.apply
          const nonColocated = freshDir("non-colocated")
          host(nonColocated, "jj git init --no-colocate --quiet")
          writeFileSync(join(nonColocated, "hello.txt"), "world\n")
          host(nonColocated, "jj commit --quiet -m init && jj bookmark set main -r @- --quiet")
          const nonColocatedMain = commitOf(nonColocated, "main")
          const nonColocatedJj = yield* Jj.Jj.pipe(Effect.provide(layerAt(nonColocated)))
          const nonColocatedProvider = JjWorkspaceSandbox.make({
            jj: nonColocatedJj,
            fs,
            path,
            spawner,
            workspacesRoot: freshDir("non-colocated-ws"),
            baseRevision: nonColocatedMain,
            env: process.env
          })
          const { work: ncWork } = yield* Sandbox.run(
            nonColocatedProvider,
            { session: "nc-lane" },
            Effect.flatMap(FileSystem.FileSystem, (laneFs) => laneFs.writeFileString("hello.txt", "updated\n"))
          )
          expect(ncWork._tag).toBe("Changed")
          const ncOutcome = yield* SandboxMerge.apply(ncWork, {
            repository: nonColocated,
            onto: "main",
            message: "non-colocated land",
            key: "nc-key",
            fetch: false
          }).pipe(Effect.provide(Layer.merge(rawPlatform, layerRepositoryMutation)))
          expect(ncOutcome._tag).toBe("Merged")
        }),
      slow
    )

    it.effect(
      "forks a live workspace preserving edits and deletions while stripping vendor logins and keeping base",
      () =>
        Effect.gen(function*() {
          const repoRoot = freshDir("fork-repo")
          const { path: repoPath, main } = hostRepository(repoRoot, {
            "keep.txt": "original\n",
            "delete-me.txt": "bye\n"
          })
          const workspacesRoot = freshDir("fork-ws")
          const { fs, path, spawner } = yield* getPlatform
          const jj = yield* Jj.Jj.pipe(Effect.provide(layerAt(repoPath)))
          const provider = JjWorkspaceSandbox.make({
            jj,
            fs,
            path,
            spawner,
            workspacesRoot,
            baseRevision: main,
            env: process.env
          })

          yield* Effect.scoped(Effect.gen(function*() {
            const parent = yield* provider.acquire("fork-parent")
            yield* parent.writeFile(join(parent.workdir, "keep.txt"), new TextEncoder().encode("parent-edit\n"))
            yield* parent.writeFile(
              join(parent.workdir, ".claude/.credentials.json"),
              new TextEncoder().encode("secret")
            )
            yield* parent.writeFile(join(parent.workdir, ".codex/auth.json"), new TextEncoder().encode("secret"))
            rmSync(join(parent.workdir, "delete-me.txt"))

            const child = yield* parent.fork!("fork-child")
            expect(new TextDecoder().decode(yield* child.readFile(join(child.workdir, "keep.txt")))).toBe(
              "parent-edit\n"
            )
            expect(existsSync(join(child.workdir, "delete-me.txt"))).toBe(false)
            expect(existsSync(join(child.workdir, ".claude/.credentials.json"))).toBe(false)
            expect(existsSync(join(child.workdir, ".codex/auth.json"))).toBe(false)

            yield* child.writeFile(join(child.workdir, "child.txt"), new TextEncoder().encode("child-edit\n"))
            const base = yield* Sandbox.resolveBase(child)
            expect(base).toBe(main)
            const work = yield* Sandbox.capture(child, { base })
            expect(work._tag).toBe("Changed")
            if (work._tag === "Changed") {
              expect(work.patch).toContain("parent-edit")
              expect(work.patch).toContain("child-edit")
              expect(work.patch).toContain("deleted file mode")
              expect(work.patch).not.toContain(".credentials.json")
            }
          }))

          // Also verify real sticky lifecycle against NodeJj
          const stickyProvider = JjWorkspaceSandbox.make({
            jj,
            fs,
            path,
            spawner,
            workspacesRoot,
            baseRevision: main,
            env: process.env,
            persistence: "sticky"
          })
          let stickyRef!: Pick<Sandbox.Session, "id" | "remoteId">
          yield* Effect.scoped(Effect.gen(function*() {
            const s = yield* stickyProvider.acquire("real-sticky")
            stickyRef = { id: s.id, remoteId: s.remoteId }
            yield* s.writeFile(join(s.workdir, "note.txt"), new TextEncoder().encode("sticky-note"))
          }))
          expect(host(repoPath, "jj --ignore-working-copy workspace list")).toContain(stickyRef.remoteId)
          yield* Effect.scoped(Effect.gen(function*() {
            const reattached = yield* stickyProvider.attach!(stickyRef)
            expect(new TextDecoder().decode(yield* reattached.readFile(join(reattached.workdir, "note.txt")))).toBe(
              "sticky-note"
            )
          }))
          yield* stickyProvider.destroy!(stickyRef)
          expect(host(repoPath, "jj --ignore-working-copy workspace list")).not.toContain(stickyRef.remoteId)
          expect(existsSync(join(workspacesRoot, stickyRef.remoteId))).toBe(false)
        }),
      slow
    )
  })
})
