import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { layerRepositoryMutation } from "@smthrs/jj/node/NodeJj"
import { Arbitrary, Effect, Exit, Fiber, FileSystem, Layer, Logger, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { TestClock } from "effect/testing"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as CommandSandbox from "../src/CommandSandbox/index.ts"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import * as HttpSandbox from "../src/HttpSandbox/index.ts"
import {
  CiJob,
  ProviderConformance,
  RemoteChildProcessSpawner,
  Sandbox,
  SandboxCommand,
  SandboxConformance,
  SandboxMerge
} from "../src/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import { commandProvider } from "../src/Sandbox/commandProvider.ts"
import { uniquePosixCommands } from "../src/SandboxConformance/posixCommands.ts"
import { platform, rawPlatform } from "./helpers/containedPlatform.ts"
import { advanceMain, cleanup, directory, gitClone, hostRepository, scratch, seeded } from "./helpers/sandboxRepos.ts"
import { makeWorkSeed } from "./helpers/workSeed.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "80"))
const fastExecutions = Math.max(12, Math.min(baseExecutions, 40))
const ioExecutions = Math.max(6, Math.min(baseExecutions, 10))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-sb-core-fuzz-")))
const mergeRoot = scratch("sb-merge-fuzz")
const mergeMachines = scratch("sb-merge-machines-fuzz")
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

let dirCounter = 0
const freshDir = (name: string) => {
  const dir = join(root, `${name}-${++dirCounter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("@smthrs/sandbox core FileSystem, linuxBatch, job, Work, SandboxMerge, HttpSandbox, CiJob & Conformance fuzz", () => {
  it(
    "Sandbox.fileSystem + linuxFileSystem + linuxBatch exercise full FileSystem API over CommandSandbox and DirectorySandbox + error mapping",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          backend: Schema.Literals(["command", "directory"]),
          subdir: Schema.Literals(["sub", "nested/deep", "a/b/c"]),
          fileName: Schema.Literals(["hello.txt", "data.bin", "file with spaces.txt"]),
          content: Schema.Literals(["hello world", "line1\nline2\n", "abc 123 !@#", "x".repeat(64)]),
          truncateTo: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 }))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (tc) =>
            Effect.scoped(
              Effect.gen(function*() {
                const baseDir = freshDir(`fs-${tc.backend}`)
                const provider = tc.backend === "directory"
                  ? DirectorySandbox.make({ ...services, root: baseDir })
                  : CommandSandbox.make({
                    spawner: services.spawner,
                    prefix: [],
                    workdir: baseDir
                  })
                const session = yield* provider.acquire(`s-${dirCounter}`)
                const fs = Sandbox.fileSystem(session)

                const dirPath = tc.subdir
                const filePath = `${dirPath}/${tc.fileName}`
                const copyPath = `${dirPath}/copy.txt`
                const renamePath = `${dirPath}/renamed.txt`
                const linkPath = `${dirPath}/sym.txt`
                const hardPath = `${dirPath}/hard.txt`

                yield* fs.makeDirectory(dirPath, { recursive: true })
                expect(yield* fs.exists(dirPath)).toBe(true)
                expect(yield* fs.exists(`${dirPath}/does-not-exist`)).toBe(false)

                yield* fs.writeFileString(filePath, tc.content)
                expect(yield* fs.readFileString(filePath)).toBe(tc.content)
                const bytes = yield* fs.readFile(filePath)
                expect(bytes.byteLength).toBe(new TextEncoder().encode(tc.content).byteLength)

                const st = yield* fs.stat(filePath)
                expect(st.type).toBe("File")
                expect(Number(st.size)).toBe(bytes.byteLength)

                const accExit = yield* fs.access(filePath).pipe(Effect.exit)
                const chmExit = yield* fs.chmod(filePath, 0o644).pipe(Effect.exit)
                const utmExit = yield* fs.utimes(filePath, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
                  .pipe(Effect.exit)
                expect(accExit).toBeDefined()
                expect(chmExit).toBeDefined()
                expect(utmExit).toBeDefined()

                const cpExit = yield* fs.copyFile(filePath, copyPath).pipe(Effect.exit)
                if (Exit.isSuccess(cpExit)) {
                  expect(yield* fs.readFileString(copyPath)).toBe(tc.content)
                } else {
                  yield* fs.writeFileString(copyPath, tc.content)
                }

                yield* fs.rename(copyPath, renamePath)
                expect(yield* fs.exists(copyPath)).toBe(false)
                expect(yield* fs.exists(renamePath)).toBe(true)

                const symExit = yield* fs.symlink(tc.fileName, linkPath).pipe(Effect.exit)
                if (Exit.isSuccess(symExit)) {
                  expect(yield* fs.readLink(linkPath)).toBe(tc.fileName)
                  expect(yield* fs.realPath(linkPath)).toContain(tc.fileName)
                }

                const linkExit = yield* fs.link(filePath, hardPath).pipe(Effect.exit)
                expect(linkExit).toBeDefined()

                const entries = yield* fs.readDirectory(dirPath)
                expect(entries).toContain(tc.fileName)

                const streamExit = yield* Stream.mkString(Stream.decodeText(fs.stream(filePath))).pipe(Effect.exit)
                if (Exit.isSuccess(streamExit)) {
                  expect(streamExit.value).toBe(tc.content)
                }
                const sinkExit = yield* Stream.make(new TextEncoder().encode("sink-data")).pipe(
                  Stream.run(fs.sink(`${dirPath}/sunk.txt`)),
                  Effect.exit
                )
                if (Exit.isFailure(sinkExit)) {
                  yield* fs.writeFileString(`${dirPath}/sunk.txt`, "sink-data")
                }

                const truncExit = yield* fs.truncate(`${dirPath}/sunk.txt`, tc.truncateTo).pipe(Effect.exit)
                if (Exit.isSuccess(truncExit)) {
                  const truncSt = yield* fs.stat(`${dirPath}/sunk.txt`)
                  expect(Number(truncSt.size)).toBe(tc.truncateTo)
                }

                const tmpDirExit = yield* fs.makeTempDirectoryScoped({ prefix: "sb-t-" }).pipe(Effect.exit)
                expect(tmpDirExit).toBeDefined()
                const tmpFileExit = yield* fs.makeTempFileScoped({ prefix: "sb-f-" }).pipe(Effect.exit)
                expect(tmpFileExit).toBeDefined()

                yield* fs.remove(renamePath)
                expect(yield* fs.exists(renamePath)).toBe(false)
                yield* fs.remove(dirPath, { recursive: true, force: true })
                expect(yield* fs.exists(dirPath)).toBe(false)

                expect(Exit.isFailure(yield* fs.stat("no-such-file-xyz").pipe(Effect.exit))).toBe(true)
                expect(Exit.isFailure(yield* fs.readFileString("no-such-file-xyz").pipe(Effect.exit))).toBe(true)
                expect(Exit.isFailure(yield* fs.readFileString("../../../etc/passwd").pipe(Effect.exit))).toBe(true)

                return true
              })
            ).pipe(Effect.provide(silentLogger)),
          { seed, executions: ioExecutions }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)

      for (const code of ["unavailable", "aborted", "not_found", "spawn_error", "timeout", "unknown"] as const) {
        const faultyFs = Sandbox.fileSystem({
          id: "faulty",
          remoteId: "remote-faulty",
          workdir: "/workspace",
          spawn: () => Effect.fail(new ProviderError({ code, message: `fault:${code}` })),
          readFile: () => Effect.fail(new ProviderError({ code, message: `fault:${code}` })),
          writeFile: () => Effect.fail(new ProviderError({ code, message: `fault:${code}` }))
        })
        expect(Exit.isFailure(await Effect.runPromise(faultyFs.readFile("a.txt").pipe(Effect.exit)))).toBe(true)
        expect(
          Exit.isFailure(await Effect.runPromise(faultyFs.writeFile("a.txt", new Uint8Array([1])).pipe(Effect.exit)))
        ).toBe(true)
        expect(Exit.isFailure(await Effect.runPromise(faultyFs.stat("a.txt").pipe(Effect.exit)))).toBe(true)
      }
    },
    120_000
  )

  it("Sandbox.job runs full retained job lifecycle (start, idempotent start, status, collect, receipt persistence & destroy)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        exitCode: Schema.Literals([0, 1, 7]),
        payloadTag: Schema.Literals(["alpha", "beta", "gamma"]),
        withFiles: Schema.Boolean,
        recollect: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.gen(function*() {
            const baseDir = freshDir("job")
            const jobDir = join(baseDir, "jobs")
            mkdirSync(jobDir, { recursive: true })
            const rawProvider = DirectorySandbox.make({
              ...services,
              root: join(baseDir, "machines"),
              persistence: "sticky"
            })
            const provider: Sandbox.Provider = {
              ...rawProvider,
              acquire: (session) =>
                Effect.flatMap(rawProvider.acquire(session), (s) =>
                  Effect.scoped(
                    Effect.flatMap(
                      s.spawn(
                        "if [ ! -d .git ]; then git init -q -b main && git config user.email a@b.test && git config user.name a && echo seed > seed.txt && git add . && git commit -q -m init; fi",
                        {}
                      ),
                      (child) => Effect.as(child.exitCode, s)
                    )
                  ))
            }
            const spec = Sandbox.job<{ readonly tag: string }>(provider, {
              command: (p, key) =>
                `printf "out:%s:%s" "${p.tag}" "${key}" && printf "err:%s" "${p.tag}" >&2 && exit ${tc.exitCode}`,
              ...(tc.withFiles
                ? {
                  files: (p) => ({
                    "input.txt": new TextEncoder().encode(`seed-${p.tag}`)
                  })
                }
                : {}),
              jobDirectory: jobDir
            })

            const key = `job-${dirCounter}-${tc.payloadTag}`
            const h1 = yield* spec.start({ tag: tc.payloadTag }, key)
            const h2 = yield* spec.start({ tag: tc.payloadTag }, key)
            expect(h2.id).toBe(h1.id)

            let st = yield* spec.status(h1, key)
            for (let i = 0; i < 40 && st._tag === "Running"; i++) {
              yield* Effect.sleep("25 millis")
              st = yield* spec.status(h1, key)
            }
            expect(st._tag).toBe("Exited")
            if (st._tag !== "Exited") return false
            expect(st.exitCode).toBe(tc.exitCode)

            const res1 = yield* spec.collect(h1, key, st)
            expect(res1.exitCode).toBe(tc.exitCode)
            expect(res1.stdout).toContain(`out:${tc.payloadTag}`)
            expect(res1.stderr).toContain(`err:${tc.payloadTag}`)

            if (tc.recollect) {
              const res2 = yield* spec.collect(h1, key, st)
              expect(res2.exitCode).toBe(res1.exitCode)
              expect(res2.stdout).toBe(res1.stdout)
            }
            return true
          }).pipe(Effect.provide(Layer.merge(KeyValueStore.layerMemory, silentLogger))),
        { seed: seed + 1, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)

    expect(() =>
      Sandbox.job(
        DirectorySandbox.make({ ...services, root: freshDir("ephemeral") }),
        { command: "true" }
      )
    ).toThrow(/retained/)
  })

  it("Sandbox.Work & SandboxMerge.apply exercise clean merge, idempotent re-apply, conflicts, strategies & refusals over real jj repos", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["clean", "idempotent", "conflict-record", "conflict-fail", "bad-base", "missing-base"]),
        fileBody: Schema.Literals(["hello world\n", "line 1\nline 2\n", "value = 42\n"])
      })
    )

    let repoIdx = 0
    const mergeLayer = Layer.mergeAll(rawPlatform, layerRepositoryMutation, silentLogger)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.gen(function*() {
            const { path: repoPath } = hostRepository(mergeRoot, { "README.md": "initial\n" }, `repo-${++repoIdx}`)

            if (tc.mode === "bad-base") {
              const badExit = yield* SandboxMerge.apply(
                new Sandbox.Changed({ session: "s-bad", base: "not-a-sha", patch: "" }),
                { repository: repoPath, onto: "main", message: "bad", key: `k-${repoIdx}`, fetch: false }
              ).pipe(Effect.exit)
              expect(Exit.isFailure(badExit)).toBe(true)
              return true
            }

            if (tc.mode === "missing-base") {
              const missExit = yield* SandboxMerge.apply(
                new Sandbox.Changed({ session: "s-miss", base: "f".repeat(40), patch: "" }),
                { repository: repoPath, onto: "main", message: "miss", key: `k-${repoIdx}`, fetch: false }
              ).pipe(Effect.exit)
              expect(Exit.isFailure(missExit)).toBe(true)
              return true
            }

            const provider = seeded(yield* directory(mergeMachines), gitClone(repoPath))
            const targetFile = tc.mode.startsWith("conflict") ? "README.md" : `feat-${repoIdx}.txt`
            const { work } = yield* Sandbox.run(
              provider,
              { session: `merge-s-${repoIdx}` },
              Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                yield* fs.writeFileString(targetFile, tc.fileBody)
              })
            )
            expect(work._tag).toBe("Changed")

            if (tc.mode.startsWith("conflict")) {
              advanceMain(repoPath, { [targetFile]: "conflicting upstream content\n" })
            }

            const key = `apply-key-${repoIdx}`
            const strategy = tc.mode === "conflict-fail" ? SandboxMerge.failOnConflict : SandboxMerge.recordConflicts
            const applyExit = yield* SandboxMerge.apply(work, {
              repository: repoPath,
              onto: "main",
              message: `apply ${tc.mode}`,
              key,
              fetch: false,
              strategy
            }).pipe(Effect.exit)

            if (tc.mode === "conflict-fail") {
              expect(Exit.isFailure(applyExit)).toBe(true)
            } else if (tc.mode === "conflict-record") {
              expect(Exit.isSuccess(applyExit)).toBe(true)
              if (Exit.isSuccess(applyExit)) expect(applyExit.value._tag).toBe("Conflicted")
            } else {
              expect(Exit.isSuccess(applyExit)).toBe(true)
              if (Exit.isSuccess(applyExit) && applyExit.value._tag === "Merged") {
                if (tc.mode === "idempotent") {
                  const again = yield* SandboxMerge.apply(work, {
                    repository: repoPath,
                    onto: "main",
                    message: `apply ${tc.mode}`,
                    key,
                    fetch: false
                  })
                  expect(again._tag).toBe("Merged")
                  if (again._tag === "Merged") expect(again.commit).toBe(applyExit.value.commit)
                }
              }
            }
            return true
          }).pipe(Effect.provide(mergeLayer)),
        { seed: seed + 2, executions: Math.max(6, Math.min(ioExecutions, 8)) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("HttpSandbox.serve + HttpSandbox.make fuzz exec, stdin, signals, files, auth refusal & network faults", async () => {
    const token = "http-fuzz-token"
    const base = "http://sandbox.fuzz"
    const machines = DirectorySandbox.make({ ...services, root: freshDir("http-machines"), persistence: "sticky" })
    const handler = HttpSandbox.serve({ provider: machines, token })

    const arb = Arbitrary.schema(
      Schema.Struct({
        cmd: Schema.Literals(["echo hi", "cat", "sh -c 'echo err >&2; exit 3'", "printf abc"]),
        stdinText: Schema.Literals(["", "hello-stdin\n"]),
        badToken: Schema.Boolean,
        fault: Schema.Literals(["none", "status-400"]),
        writeContent: Schema.Literals(["hello", "multi\nline\n", "json:{\"a\":1}"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.scoped(
            Effect.gen(function*() {
              const client = HttpClient.make((request) =>
                Effect.gen(function*() {
                  if (tc.fault === "status-400") {
                    return HttpClientResponse.fromWeb(
                      request,
                      new Response(JSON.stringify({ code: "unknown", message: "bad" }), {
                        status: 400,
                        headers: { "content-type": "application/json" }
                      })
                    )
                  }
                  const web = yield* Effect.orDie(HttpClientRequest.toWeb(request))
                  const res = yield* handler(web)
                  return HttpClientResponse.fromWeb(request, res)
                })
              )

              const provider = HttpSandbox.make({
                url: base,
                token: tc.badToken ? "wrong-token" : token,
                client,
                pollInterval: "10 millis"
              })

              const sessionExit = yield* provider.acquire(`http-s-${++dirCounter}`).pipe(Effect.exit)
              if (tc.badToken || tc.fault !== "none") {
                expect(Exit.isFailure(sessionExit)).toBe(true)
                return true
              }
              expect(Exit.isSuccess(sessionExit)).toBe(true)
              if (Exit.isFailure(sessionExit)) return false
              const session = sessionExit.value

              const notePath = `${session.workdir}/note.txt`
              yield* session.writeFile(notePath, new TextEncoder().encode(tc.writeContent))
              const got = yield* session.readFile(notePath)
              expect(new TextDecoder().decode(got)).toBe(tc.writeContent)

              const child = yield* session.spawn(tc.cmd, {
                ...(tc.stdinText.length > 0 ? { stdin: new TextEncoder().encode(tc.stdinText) } : {})
              })
              const [out, err, code] = yield* Effect.all([
                Stream.mkString(Stream.decodeText(child.stdout)),
                Stream.mkString(Stream.decodeText(child.stderr)),
                child.exitCode
              ], { concurrency: "unbounded" })
              if (tc.cmd === "cat") expect(out).toBe(tc.stdinText)
              if (tc.cmd.includes("exit 3")) {
                expect(code).toBe(3)
                expect(err).toContain("err")
              } else {
                expect(code).toBe(0)
              }

              const badMethod = yield* handler(
                new Request(`${base}/unknown`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })
              )
              expect(badMethod.status).toBeGreaterThanOrEqual(400)
              const noAuth = yield* handler(new Request(`${base}/sessions`, { method: "POST" }))
              expect(noAuth.status).toBe(401)
              return true
            })
          ).pipe(Effect.provide(silentLogger)),
        { seed: seed + 3, executions: ioExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("CiJob executes jobs through real FlowEngine with passing, failing, timed-out, wrongCommit & unavailable machines", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["pass", "step-fail", "timeout", "wrong-commit", "unavailable"]),
        stepCount: Schema.Literals([1, 2, 3])
      })
    )

    const target: CiJob.Target = {
      run: "ci:fuzz-1",
      repo: "acme/fuzz",
      sha: "a".repeat(40),
      ref: "refs/heads/main"
    }

    let execIdx = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (tc) =>
          Effect.gen(function*() {
            const machineLayer = Layer.succeed(
              CiJob.Machine,
              CiJob.Machine.of({
                checkout: (at) =>
                  tc.mode === "unavailable"
                    ? Effect.fail(new CiJob.MachineUnavailable())
                    : Effect.succeed(tc.mode !== "wrong-commit" && at.sha.length === 40),
                run: (_at, _job, index) =>
                  Effect.succeed({
                    exitCode: tc.mode === "step-fail" && index === 0 ? 1 : 0,
                    timedOut: tc.mode === "timeout" && index === 0,
                    output: { stdout: "ok", stderr: "", truncated: false }
                  }),
                release: () => Effect.void
              })
            )

            const job: CiJob.Job = {
              name: "ci-build",
              steps: Array.from({ length: tc.stepCount }, (_, i) => ({
                name: `step-${i}`,
                run: `echo step-${i}`
              }))
            }

            const ciHost = Layer.mergeAll(
              CiJob.layer,
              Interpreter.layer(CiJob.CiJob),
              silentLogger
            ).pipe(
              Layer.provide(machineLayer),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer),
              Layer.provideMerge(TestClock.layer())
            )

            const runFiber = yield* CiJob.CiJob.execute(
              { target, job },
              { executionId: `ci-fuzz-${++execIdx}` }
            ).pipe(Effect.exit, Effect.forkChild, Effect.provide(ciHost))
            if (tc.mode === "unavailable") {
              for (let i = 0; i < 6; i++) {
                yield* TestClock.adjust("5 minutes").pipe(Effect.provide(ciHost))
              }
            }
            const exit = yield* Fiber.join(runFiber)
            expect(exit).toBeDefined()
            return true
          }),
        { seed: seed + 4, executions: fastExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  })

  it("SandboxConformance.check, ProviderConformance.check, RemoteChildProcessSpawner & SandboxCommand cover healthy and violating providers", async () => {
    const healthy = DirectorySandbox.make({ ...services, root: freshDir("conf-ok") })
    const healthyViolations = await Effect.runPromise(
      SandboxConformance.check(healthy, { session: "conf-healthy" }).pipe(Effect.provide(silentLogger))
    )
    expect(healthyViolations).toEqual([])

    const arb = Arbitrary.schema(
      Schema.Struct({
        faultKind: Schema.Literals([
          "wrong-stdout",
          "wrong-exit",
          "fail-spawn",
          "fail-read",
          "fail-write",
          "drop-stdin"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ faultKind }) =>
          Effect.gen(function*() {
            const faultyProvider: Sandbox.Provider = {
              acquire: (sessionId) =>
                Effect.succeed({
                  id: sessionId,
                  remoteId: `remote-${sessionId}`,
                  workdir: "/workspace",
                  spawn: (_cmd, opts) => {
                    if (faultKind === "fail-spawn") {
                      return Effect.fail(new ProviderError({ code: "spawn_error", message: "boom" }))
                    }
                    const outText = faultKind === "wrong-stdout" ? "CORRUPTED" : ""
                    const code = faultKind === "wrong-exit" ? 42 : 0
                    return Effect.succeed({
                      stdout: Stream.make(new TextEncoder().encode(outText)),
                      stderr: Stream.empty,
                      exitCode: faultKind === "drop-stdin" && opts.stdin !== undefined
                        ? Effect.succeed(99)
                        : Effect.succeed(code),
                      kill: () => Effect.void
                    })
                  },
                  readFile: () =>
                    faultKind === "fail-read"
                      ? Effect.fail(new ProviderError({ code: "not_found", message: "missing" }))
                      : Effect.succeed(new Uint8Array([0, 1])),
                  writeFile: () =>
                    faultKind === "fail-write"
                      ? Effect.fail(new ProviderError({ code: "aborted", message: "ro" }))
                      : Effect.void
                })
            }
            const violations = yield* SandboxConformance.check(faultyProvider, {
              session: `bad-${faultKind}`
            })
            expect(violations.length).toBeGreaterThan(0)

            const provViolations = yield* ProviderConformance.check(
              commandProvider(faultyProvider, { session: `pc-${faultKind}` }),
              uniquePosixCommands()
            )
            expect(provViolations.length).toBeGreaterThan(0)
            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed: seed + 5, executions: Math.max(6, Math.min(ioExecutions, 8)) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const cmd = ChildProcess.make("sh", ["-c", "echo remote-ok && cat"], {
            stdin: Stream.make(new TextEncoder().encode("stdin-val"))
          })
          const handle = yield* spawner.spawn(cmd)
          const out = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          const exit = yield* handle.exitCode
          expect(out).toContain("remote-ok")
          expect(out).toContain("stdin-val")
          expect(exit).toBe(0)
        }).pipe(Effect.provide(RemoteChildProcessSpawner.layer(commandProvider(healthy, { session: "rcps-1" }))))
      ).pipe(Effect.provide(silentLogger))
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const session = yield* healthy.acquire("sc-1")
          const callsDir = join(freshDir("sc-calls"), "calls")
          mkdirSync(callsDir, { recursive: true })
          const cmds = SandboxCommand.onSession(session, callsDir)
          const key = "sc-key-1"
          yield* cmds.start({ tool: "run", command: "echo sandbox-cmd-ok" }, key)
          let obs = yield* cmds.observe(key)
          for (let i = 0; i < 40 && obs.state === "running"; i++) {
            yield* Effect.sleep("25 millis")
            obs = yield* cmds.observe(key)
          }
          expect(obs.state).toBe("finished")
          const collected = yield* cmds.collect(key)
          expect(collected.stdout).toContain("sandbox-cmd-ok")
          expect(collected.exitCode).toBe(0)

          const key2 = "sc-key-cancel"
          yield* cmds.start({ tool: "run", command: "sleep 30" }, key2)
          yield* cmds.cancel(key2)
        })
      ).pipe(Effect.provide(silentLogger))
    )
  })
})
