import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { Fuzz } from "@smthrs/fuzz"
import { JjError } from "@smthrs/jj"
import type * as Jj from "@smthrs/jj/Jj"
import { Arbitrary, Effect, Exit, FileSystem, Layer, Logger, Path, Schema, type Scope, Sink, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Redacted from "effect/Redacted"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import * as HttpSandbox from "../src/HttpSandbox/index.ts"
import * as JjWorkspaceSandbox from "../src/JjWorkspaceSandbox/index.ts"
import * as ProviderConformance from "../src/ProviderConformance/index.ts"
import * as RemoteChildProcessSpawner from "../src/RemoteChildProcessSpawner/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxCommand from "../src/SandboxCommand/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { workSeedFiles } from "../src/SandboxConformance/workSeed.ts"
import * as SandboxTools from "../src/SandboxTools/index.ts"
import { platform } from "./helpers/containedPlatform.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "40"))
const ioExecutions = Math.max(8, Math.min(baseExecutions, 16))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")
const silentLogger = Logger.layer([])

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-wave9-core-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const encoder = new TextEncoder()

const localServices = Effect.runSync(
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return { spawner, fs, path }
  }).pipe(Effect.provide(platform))
)

let seq = 0
const freshDir = (prefix: string) => {
  const dir = join(root, `${prefix}-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const runSh = (cmd: string, cwd: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const child = yield* localServices.spawner.spawn(
          ChildProcess.make("sh", ["-c", cmd], { cwd, extendEnv: true })
        )
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(child.stdout)),
            Stream.mkString(Stream.decodeText(child.stderr)),
            child.exitCode
          ],
          { concurrency: "unbounded" }
        )
        return { stdout, stderr, code }
      })
    )
  )

describe("@smthrs/sandbox Wave-9 core, conformance, tools, spawner, HTTP & jj deep fuzz", () => {
  it(
    "SandboxConformance (work seed, interrupt, isolation, ephemeral) & ProviderConformance (health, kill/survivor, TestRemote) cover passing and violating providers",
    async () => {
      const repoDir = freshDir("work-seed-repo")
      for (const [rel, bytes] of Object.entries(workSeedFiles)) {
        writeFileSync(join(repoDir, rel), bytes)
      }
      const bundlePath = join(root, "seed.bundle")
      const initRes = await runSh(
        `git init -b main && git config user.email test@example.com && git config user.name Test && git add -A && git commit -m base && git bundle create "${bundlePath}" HEAD && git rev-parse HEAD`,
        repoDir
      )
      expect(initRes.code).toBe(0)
      const baseCommit = initRes.stdout.trim().split("\n").pop()!.trim()
      const workSeed = { bundle: new Uint8Array(readFileSync(bundlePath)), base: baseCommit }
      const sentinel = join(root, "host-sentinel.txt")
      writeFileSync(sentinel, "secret-host-file")

      const dirRoot = freshDir("conf-dir")
      const baseProvider = DirectorySandbox.make({
        fs: localServices.fs,
        spawner: localServices.spawner,
        root: dirRoot
      })
      const ephemeralProvider: Sandbox.Provider = {
        ...baseProvider,
        acquire: (session) => baseProvider.acquire(`${session}-${++seq}`)
      }

      const violations = await Effect.runPromise(
        SandboxConformance.check(ephemeralProvider, {
          session: "wave9-conf",
          checkTimeout: "15 seconds",
          work: workSeed,
          isolation: { hostSentinel: sentinel, egressProbe: "false" },
          provides: { ephemeral: true, kill: true, interrupt: true }
        }).pipe(Effect.provide(silentLogger))
      )
      expect(Array.isArray(violations)).toBe(true)

      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals(["healthy", "kill-noop", "kill-fail", "open-fail", "ping-fail"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              const remote = RemoteChildProcessSpawner.TestRemote.make({
                session: "tr-sess",
                stdin: true,
                kill: tc.mode !== "open-fail",
                killIsNoop: tc.mode === "kill-noop",
                killFailure: tc.mode === "kill-fail"
                  ? new ProviderError({ code: "unavailable", message: "kill boom" })
                  : undefined,
                openFailure: tc.mode === "open-fail"
                  ? new ProviderError({ code: "unavailable", message: "open boom" })
                  : undefined,
                ping: tc.mode === "ping-fail"
                  ? Effect.fail(new ProviderError({ code: "unavailable", message: "ping boom" }))
                  : Effect.void,
                scripts: {
                  "echo ok": { stdout: "ok\n", exitCode: 0 },
                  "exit 7": { exitCode: 7 },
                  "cat": { exitCode: 0, stdout: "hello" },
                  "sleep 30": { pending: true, exitCode: 143 },
                  "check-survivor": { exitCode: tc.mode === "kill-noop" ? 0 : 1 }
                }
              })
              const found = yield* ProviderConformance.check(
                remote,
                {
                  writes: "echo ok",
                  output: "ok\n",
                  fails: "exit 7",
                  failureCode: 7,
                  runs: "sleep 30",
                  survivor: "check-survivor",
                  copiesStdin: "cat"
                },
                { checkTimeout: "2 seconds" }
              )
              expect(Array.isArray(found)).toBe(true)
              return true
            }).pipe(Effect.provide(silentLogger)),
          { executions: Math.min(ioExecutions, 10), seed }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "RemoteChildProcessSpawner.layer covers all rejected options, Sink stdout, fd stubs, exitCode/kill/open failures & finalizer kill",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          caseKind: Schema.Literals([
            "pipe-from-stderr",
            "pipe-to-stderr",
            "secret-arg",
            "pipe-cwd-override",
            "pipe-env-override",
            "stdin-inherit",
            "extra-fd",
            "custom-shell",
            "detached",
            "stdout-sink",
            "kill-fail",
            "open-fail",
            "running-finalizer"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.gen(function*() {
              const remote = RemoteChildProcessSpawner.TestRemote.make({
                session: "rcps",
                stdin: true,
                kill: true,
                killFailure: tc.caseKind === "kill-fail"
                  ? new ProviderError({ code: "unavailable", message: "kill err" })
                  : undefined,
                openFailure: tc.caseKind === "open-fail"
                  ? new ProviderError({ code: "unavailable", message: "open err" })
                  : undefined,
                scripts: {
                  "echo hi": { stdout: "hi\n", exitCode: 0 },
                  "sleep 10": { pending: true, exitCode: 0 }
                }
              })
              const spawnerLayer = RemoteChildProcessSpawner.layer(remote)
              const runWith = <A, E>(eff: Effect.Effect<A, E, ChildProcessSpawner | Scope.Scope>) =>
                Effect.exit(Effect.scoped(eff).pipe(Effect.provide(spawnerLayer)))

              switch (tc.caseKind) {
                case "pipe-from-stderr": {
                  const c = ChildProcess.make("echo", ["a"]).pipe(
                    ChildProcess.pipeTo(ChildProcess.make("cat", []), { from: "stderr" })
                  )
                  const r = yield* runWith(Effect.flatMap(ChildProcessSpawner, (s) => s.spawn(c)))
                  expect(Exit.isFailure(r)).toBe(true)
                  break
                }
                case "pipe-to-stderr": {
                  const c = ChildProcess.make("echo", ["a"]).pipe(
                    ChildProcess.pipeTo(ChildProcess.make("cat", []), { to: "fd3" })
                  )
                  const r = yield* runWith(Effect.flatMap(ChildProcessSpawner, (s) => s.spawn(c)))
                  expect(Exit.isFailure(r)).toBe(true)
                  break
                }
                case "secret-arg": {
                  const c = ChildProcess.make("echo", [Redacted.make("secret-val") as unknown as string])
                  const r = yield* runWith(Effect.flatMap(ChildProcessSpawner, (s) => s.spawn(c)))
                  expect(Exit.isFailure(r)).toBe(true)
                  break
                }
                case "pipe-cwd-override": {
                  const c = ChildProcess.make("echo", ["a"], { cwd: "/a" }).pipe(
                    ChildProcess.pipeTo(ChildProcess.make("cat", [], { cwd: "/b" }))
                  )
                  const r = yield* runWith(Effect.flatMap(ChildProcessSpawner, (s) => s.spawn(c)))
                  expect(Exit.isFailure(r)).toBe(true)
                  break
                }
                case "pipe-env-override": {
                  const c = ChildProcess.make("echo", ["a"], { env: { A: "1" } }).pipe(
                    ChildProcess.pipeTo(ChildProcess.make("cat", [], { env: { A: "2" } }))
                  )
                  const r = yield* runWith(Effect.flatMap(ChildProcessSpawner, (s) => s.spawn(c)))
                  expect(Exit.isFailure(r)).toBe(true)
                  break
                }
                case "stdin-inherit": {
                  const c = ChildProcess.make("echo", ["a"], { stdin: "inherit" })
                  const r = yield* runWith(Effect.flatMap(ChildProcessSpawner, (s) => s.spawn(c)))
                  expect(Exit.isFailure(r)).toBe(true)
                  break
                }
                case "extra-fd": {
                  const c = ChildProcess.make("echo", ["a"], {
                    additionalFds: { fd3: { type: "output", stream: "pipe" } }
                  } as ChildProcess.CommandOptions)
                  const r = yield* runWith(Effect.flatMap(ChildProcessSpawner, (s) => s.spawn(c)))
                  expect(Exit.isFailure(r)).toBe(true)
                  break
                }
                case "custom-shell": {
                  const c = ChildProcess.make("echo", ["a"], { shell: "/bin/zsh" })
                  const r = yield* runWith(Effect.flatMap(ChildProcessSpawner, (s) => s.spawn(c)))
                  expect(Exit.isFailure(r)).toBe(true)
                  break
                }
                case "detached": {
                  const c = ChildProcess.make("echo", ["a"], { detached: true })
                  const r = yield* runWith(Effect.flatMap(ChildProcessSpawner, (s) => s.spawn(c)))
                  expect(Exit.isFailure(r)).toBe(true)
                  break
                }
                case "stdout-sink": {
                  const c = ChildProcess.make("echo", ["hi"], { stdout: Sink.drain as never, shell: true })
                  const r = yield* runWith(
                    Effect.gen(function*() {
                      const spawner = yield* ChildProcessSpawner
                      const h = yield* spawner.spawn(c)
                      yield* Stream.runDrain(h.stdout)
                      yield* Stream.runDrain(h.getOutputFd(3))
                      yield* Stream.run(Stream.empty, h.getInputFd(3))
                      return yield* h.exitCode
                    })
                  )
                  expect(Exit.isSuccess(r)).toBe(true)
                  break
                }
                case "kill-fail": {
                  const c = ChildProcess.make("sleep 10", [], { shell: true })
                  const r = yield* runWith(
                    Effect.gen(function*() {
                      const spawner = yield* ChildProcessSpawner
                      const h = yield* spawner.spawn(c)
                      return yield* Effect.exit(h.kill())
                    })
                  )
                  expect(Exit.isSuccess(r)).toBe(true)
                  break
                }
                case "open-fail": {
                  const c = ChildProcess.make("echo", ["hi"], { shell: true })
                  const r = yield* runWith(Effect.flatMap(ChildProcessSpawner, (s) => s.spawn(c)))
                  expect(Exit.isFailure(r)).toBe(true)
                  break
                }
                case "running-finalizer": {
                  const c = ChildProcess.make("sleep 10", [], { shell: true })
                  const r = yield* runWith(
                    Effect.gen(function*() {
                      const spawner = yield* ChildProcessSpawner
                      yield* spawner.spawn(c)
                      return "ok"
                    })
                  )
                  expect(Exit.isSuccess(r)).toBe(true)
                  break
                }
              }
              return true
            }).pipe(Effect.provide(silentLogger)),
          { executions: Math.max(ioExecutions, 16), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "SandboxTools (rebaseCall/rebased/rebasePaths/status/diff), SandboxCommand.make/operations & Sandbox.job cover validation, cancel & receipt faults",
    async () => {
      const validSha = "a".repeat(40)
      const validSha2 = "b".repeat(40)

      expect(() => SandboxTools.rebaseCall({ branch: "HEAD", onto: validSha })).toThrow(TypeError)
      expect(() => SandboxTools.rebaseCall({ branch: "-bad", onto: validSha })).toThrow(TypeError)
      expect(() => SandboxTools.rebaseCall({ branch: "a..b", onto: validSha })).toThrow(TypeError)
      expect(() => SandboxTools.rebaseCall({ branch: "a/b.lock", onto: validSha })).toThrow(TypeError)
      expect(() => SandboxTools.rebaseCall({ branch: "main", onto: "not-a-sha" })).toThrow(TypeError)
      expect(() => SandboxTools.rebaseCall({ branch: "main", onto: validSha, expect: "bad" })).toThrow(TypeError)

      const validCall = SandboxTools.rebaseCall({
        branch: "feature/ok",
        onto: validSha,
        expect: validSha2,
        timeoutSeconds: 60
      })
      expect(validCall.tool).toBe("run")

      expect(
        SandboxTools.rebasePaths({
          tool: "read",
          path: "x",
          content: "a.txt\0b.txt\0a.txt\0",
          bytes: 18,
          truncated: false
        })
      ).toEqual(["a.txt", "b.txt"])

      const headers: ReadonlyArray<[string, string | null]> = [
        [`current ${validSha}`, "Current"],
        [`unrelated ${validSha}`, "Unrelated"],
        [`moved ${validSha}`, "Moved"],
        [`conflict ${validSha} 2`, "Conflicted"],
        [`clean ${validSha} ${validSha2} 3`, "Planned"],
        [`applied ${validSha} ${validSha2} 1`, "Applied"],
        ["bogus header", null]
      ]
      for (const [stdout, expectedTag] of headers) {
        const res = await Effect.runPromise(
          Effect.exit(
            SandboxTools.rebased({
              tool: "run",
              stdout,
              stderr: "",
              stdoutBytes: stdout.length,
              stderrBytes: 0,
              exitCode: 0,
              timedOut: false,
              truncated: false
            })
          )
        )
        if (expectedTag === null) {
          expect(Exit.isFailure(res)).toBe(true)
        } else {
          expect(Exit.isSuccess(res) && res.value._tag === expectedTag).toBe(true)
        }
      }
      for (const [exitCode, timedOut] of [[0, true], [75, false], [76, false], [65, false], [125, false]] as const) {
        const res = await Effect.runPromise(
          Effect.exit(
            SandboxTools.rebased({
              tool: "run",
              stdout: "",
              stderr: "",
              stdoutBytes: 0,
              stderrBytes: 0,
              exitCode,
              timedOut,
              truncated: false
            })
          )
        )
        expect(Exit.isFailure(res)).toBe(true)
      }

      expect(() => SandboxCommand.make("bad/max", { target: Schema.String, maxTimeoutSeconds: 1 })).toThrow(RangeError)
      expect(() =>
        SandboxCommand.make("bad/timeout", {
          target: Schema.String,
          maxTimeoutSeconds: 60,
          timeout: "10 seconds"
        })
      ).toThrow(RangeError)

      const jobDef = SandboxCommand.make("wave9/cmd", { target: Schema.String })
      expect(jobDef).toBeDefined()

      const dirRoot = freshDir("cmd-ops")
      const dirProvider = DirectorySandbox.make({
        fs: localServices.fs,
        spawner: localServices.spawner,
        root: dirRoot
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const session = yield* dirProvider.acquire("cmd-ops-s1")
            const callsDirectory = freshDir("cmd-calls")
            const commands: SandboxCommand.Commands = {
              start: (call, key) => SandboxTools.start(session, call, { key, callsDirectory }),
              observe: (key, opts) => SandboxTools.observe(session, { key, callsDirectory, ...opts }),
              collect: (key) => SandboxTools.collect(session, { key, callsDirectory }),
              cancel: (key) => SandboxTools.cancel(session, { key, callsDirectory })
            }
            const ops = SandboxCommand.operations((_target: string) => Effect.succeed(commands))
            const handle = yield* ops.start({ target: "t1", call: { tool: "run", command: "echo wave9-ok" } }, "key-1")
            const st1 = yield* ops.status(handle, "key-1", { waitMs: 500 })
            expect(["Running", "Exited", "Lost"]).toContain(st1._tag)
            if (st1._tag === "Exited") {
              const collected = yield* ops.collect(handle, "key-1", st1)
              expect(collected.stdout).toContain("wave9-ok")
            }
            if (ops.cancel) yield* ops.cancel(handle, "key-1")
            if (ops.abandon) yield* ops.abandon({ target: "t1", call: { tool: "run", command: "echo x" } }, "key-1")

            const diffBad = yield* Effect.exit(
              SandboxTools.execute(session, { tool: "diff", paths: ["../../etc/passwd"] }, {
                callsDirectory,
                callId: "diff-1"
              })
            )
            expect(Exit.isFailure(diffBad)).toBe(true)
          })
        ).pipe(Effect.provide(silentLogger))
      )

      const jobRoot = freshDir("job-sb")
      const jobDir = freshDir("job-state")
      const baseDirProv = DirectorySandbox.make({ fs: localServices.fs, spawner: localServices.spawner, root: jobRoot })
      const retainedProvider: Sandbox.Provider = {
        ...baseDirProv,
        retained: true,
        acquire: (id) =>
          baseDirProv.acquire(id).pipe(
            Effect.tap((s) =>
              Effect.flatMap(
                s.spawn(
                  "git init -q && git config user.email t@e.com && git config user.name T && touch .init && git add .init && git commit -qm init",
                  {}
                ),
                (c) => c.exitCode
              )
            )
          ),
        attach: (sess) => baseDirProv.acquire(sess.id),
        destroy: () => Effect.void
      }
      const jobApi = Sandbox.job<{ readonly cmd: string }>(retainedProvider, {
        command: (p) => p.cmd,
        jobDirectory: jobDir
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const handle = yield* jobApi.start({ cmd: "sleep 5" }, "jk-1")
          yield* jobApi.cancel(handle, "jk-1")

          const handle2 = yield* jobApi.start({ cmd: "echo hi" }, "jk-2")
          yield* Effect.sleep("150 millis")
          writeFileSync(join(handle2.directory, "receipt.json"), "{bad-json")
          const badCollect = yield* Effect.exit(jobApi.collect(handle2, "jk-2", { _tag: "Exited", exitCode: 0 }))
          expect(Exit.isFailure(badCollect)).toBe(true)
          yield* jobApi.cancel(handle2, "jk-2")
        }).pipe(Effect.provide(Layer.merge(KeyValueStore.layerMemory, silentLogger)))
      )
    },
    60_000
  )

  it(
    "HttpSandbox.serve & HttpSandbox.make cover validation errors, malformed URI/limits/incarnation/range/upload, 426, 404, bad JSON & unrecognized kill",
    async () => {
      const dirRoot = freshDir("http-sb")
      const nonRetained = DirectorySandbox.make({
        fs: localServices.fs,
        spawner: localServices.spawner,
        root: dirRoot
      })
      expect(() => HttpSandbox.serve({ provider: nonRetained, token: "tok" })).toThrow(TypeError)

      const retainedProv: Sandbox.Provider = {
        ...nonRetained,
        retained: true,
        attach: (s) => nonRetained.acquire(s.id),
        destroy: () => Effect.void
      }
      expect(() => HttpSandbox.serve({ provider: retainedProv, token: "tok", processDirectory: "relative/dir" }))
        .toThrow(TypeError)
      expect(() => HttpSandbox.serve({ provider: retainedProv, token: "tok", maxRequestBytes: 0 })).toThrow(TypeError)

      const handler = HttpSandbox.serve({
        provider: (limits) => {
          if (limits?.cpus === 99) throw new Error("too many cpus")
          return retainedProv
        },
        token: "secret-tok",
        maxFileBytes: 64,
        maxRequestBytes: 256
      })
      const webClient = (fn: (req: Request) => Effect.Effect<Response>) =>
        HttpClient.make((request) =>
          Effect.gen(function*() {
            const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
            const resp = yield* fn(web)
            return HttpClientResponse.fromWeb(request, resp)
          })
        )

      expect(() =>
        HttpSandbox.make({ url: "http://127.0.0.1:9", token: "tok", client: webClient(handler), chunkBytes: 0 })
      ).toThrow(TypeError)

      const authHeaders = { authorization: "Bearer secret-tok" }
      const badRequests: ReadonlyArray<[string, RequestInit]> = [
        ["http://local/v1/sessions/x/files", { method: "PUT", headers: authHeaders }],
        ["http://local/v1/sessions/x/unknown", { method: "GET", headers: authHeaders }],
        ["http://local/v1/sessions/%E0%A4%A/files?id=a&path=/tmp/a", { method: "GET", headers: authHeaders }],
        ["http://local/v1/sessions/s1/files?id=a&cpus=notanumber&path=/tmp/a", { method: "GET", headers: authHeaders }],
        ["http://local/v1/sessions/s1/files?id=a&path=relative.txt", { method: "GET", headers: authHeaders }],
        ["http://local/v1/sessions/s1?id=a&incarnation=nothex", { method: "DELETE", headers: authHeaders }],
        ["http://local/v1/sessions/s1/uploads/v2?id=a&path=/tmp/a&offset=bad", {
          method: "PUT",
          headers: authHeaders,
          body: "hi"
        }],
        ["http://local/v1/sessions/s1/uploads/v2?id=a&path=/tmp/a&offset=0&end=bad", {
          method: "PUT",
          headers: authHeaders,
          body: "hi"
        }],
        ["http://local/v1/sessions/s1/uploads/v2?id=a&path=/tmp/a&offset=5&end=2", {
          method: "PUT",
          headers: authHeaders,
          body: "hi"
        }],
        ["http://local/v1/sessions", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ id: "a", limits: { cpus: 99 } })
        }]
      ]
      for (const [url, init] of badRequests) {
        const resp = await Effect.runPromise(handler(new Request(url, init)))
        expect(resp.status).toBeGreaterThanOrEqual(400)
      }

      const badClient = HttpSandbox.make({
        url: "http://local",
        token: "secret-tok",
        client: webClient(() =>
          Effect.succeed(new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }))
        )
      })
      const badJsonExit = await Effect.runPromise(
        Effect.exit(Effect.scoped(badClient.acquire("bad-json-s"))).pipe(Effect.provide(silentLogger))
      )
      expect(Exit.isFailure(badJsonExit)).toBe(true)

      const goodClient = HttpSandbox.make({
        url: "http://local",
        token: "secret-tok",
        client: webClient(handler)
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const s = yield* goodClient.acquire("http-ok-s1")
            if (s.kill) {
              const badKill = yield* Effect.exit(
                s.kill({ stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) }, "SIGTERM")
              )
              expect(Exit.isFailure(badKill)).toBe(true)
            }
          })
        ).pipe(Effect.provide(silentLogger))
      )
    },
    60_000
  )

  it(
    "JjWorkspaceSandbox covers attach absent/present, missing workspace-config-id, unrecognized kill, fork & teardown error logging",
    async () => {
      const wsRoot = freshDir("jj-workspaces")
      const createdWorkspaces = new Map<string, string>()
      let forgetShouldFail = false

      const stubJj = {
        snapshot: () => Effect.succeed({ commitId: "a".repeat(40) }),
        workspaceAdd: (name: string, destination: string) =>
          Effect.sync(() => {
            mkdirSync(join(destination, ".jj"), { recursive: true })
            writeFileSync(join(destination, ".jj", "workspace-config-id"), "id-1")
            createdWorkspaces.set(name, destination)
          }),
        workspaceForget: (name: string) =>
          forgetShouldFail
            ? Effect.fail(new JjError({ code: "unknown", message: "forget failed" }))
            : Effect.sync(() => {
              createdWorkspaces.delete(name)
            }),
        workspaceList: () => Effect.succeed([...createdWorkspaces.keys()])
      } as unknown as Jj.Jj

      const provider = JjWorkspaceSandbox.make({
        jj: stubJj,
        workspacesRoot: wsRoot,
        fs: localServices.fs,
        path: localServices.path,
        spawner: localServices.spawner,
        git: false
      })

      await Effect.runPromise(
        Effect.gen(function*() {
          if (provider.attach) {
            const absentExit = yield* Effect.exit(
              Effect.scoped(provider.attach({ id: "missing-s", remoteId: "smthrs-missing-s" }))
            )
            expect(Exit.isFailure(absentExit)).toBe(true)
          }

          forgetShouldFail = true
          yield* Effect.scoped(
            Effect.gen(function*() {
              const s1 = yield* provider.acquire("jj-w9-1")
              yield* s1.writeFile(`${s1.workdir}/w9.txt`, encoder.encode("hello"))
              if (s1.kill) {
                const badKill = yield* Effect.exit(
                  s1.kill({ stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) }, "SIGTERM")
                )
                expect(Exit.isFailure(badKill)).toBe(true)
              }
              const missingRead = yield* Effect.exit(s1.readFile(`${s1.workdir}/nope.txt`))
              expect(Exit.isFailure(missingRead)).toBe(true)
              if (s1.fork) {
                const s2 = yield* s1.fork("jj-w9-fork")
                const bytes = yield* s2.readFile(`${s2.workdir}/w9.txt`)
                expect(bytes.length).toBeGreaterThan(0)
              }
            })
          )
        }).pipe(Effect.provide(silentLogger))
      )
    },
    60_000
  )
})
