/**
 * Wave-9H Deep Sweep: Bug, ExecutionEnvironment, Agents, CloudSandbox, Spool,
 * ClaudeCode, CodexLogin, Suggest, Evaluation, EvalCli, Memory, Triggers,
 * TriggerPlans, TargetRuns, RunnerJobs, LocalJobs, Workstreams, Runner & Lane.
 */
import { NodeServices } from "@effect/platform-node"
import * as AgentRunner from "@smthrs/agent/AgentRunner"
import * as Transcript from "@smthrs/agent/Transcript"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { TestClock } from "effect/testing"
import { chmodSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"
import * as Bug from "../src/Bug.ts"
import * as CloudSandbox from "../src/CloudSandbox.ts"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as EvalCli from "../src/evaluation/EvalCli.ts"
import * as Evaluation from "../src/evaluation/Evaluation.ts"
import * as ExecutionEnvironment from "../src/ExecutionEnvironment.ts"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import * as CodexLogin from "../src/internal/CodexLogin.ts"
import * as MemoryCli from "../src/operator/Memory.ts"
import * as TargetRuns from "../src/operator/TargetRuns.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as TriggersCli from "../src/operator/Triggers.ts"
import * as Config from "../src/runner/Config.ts"
import * as Host from "../src/runner/Host.ts"
import * as Lane from "../src/runner/Lane.ts"
import * as LaneIntake from "../src/runner/LaneIntake.ts"
import * as LocalJobs from "../src/runner/LocalJobs.ts"
import * as Spool from "../src/runner/Spool.ts"
import * as Workstreams from "../src/runner/Workstreams.ts"
import * as RunnerJobs from "../src/RunnerJobs.ts"
import * as Suggest from "../src/Suggest.ts"
import * as Lanes from "./fixtures/runner/lanes.ts"

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("@smthrs/cli Wave-9H Deep Sweep (Pure/Local Modules, Eval, Operators & Runner)", () => {
  it(
    "Bug, ExecutionEnvironment, Agents, CloudSandbox & runner/Spool cover all redaction guards, registry errors, lease/delete retries & torn spool lines",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9h-pure-", async (tmp) => {
        // 1. Bug.scrub: every refusal & edge branch
        expect(() => Bug.scrub({ fn: () => 1 })).toThrow("callable")
        expect(() => Bug.scrub(new Proxy({}, {}))).toThrow("proxy")
        class CustomProto {
          x = 1
        }
        expect(() => Bug.scrub(new CustomProto())).toThrow("prototype")
        const withGetter = {}
        Object.defineProperty(withGetter, "a", { enumerable: true, get: () => 1 })
        expect(() => Bug.scrub(withGetter)).toThrow("accessor")
        expect(() => Bug.scrub({ toJSON: () => 1 })).toThrow("toJSON")
        expect(() => Bug.scrub(new ArrayBuffer(2 * 1024 * 1024))).toThrow("byte walk limit")
        const deep: Record<string, unknown> = {}
        let cur = deep
        for (let i = 0; i < 500; i++) {
          cur.next = {}
          cur = cur.next as Record<string, unknown>
        }
        expect(() => Bug.scrub(deep)).toThrow("depth limit")
        const wide: Record<string, number> = {}
        for (let i = 0; i < 200_000; i++) wide[`k${i}`] = i
        expect(() => Bug.scrub(wide)).toThrow("member walk limit")
        const circ: Record<string, unknown> = { ok: 1 }
        circ.self = circ
        const symObj = { [Symbol("skip")]: "ignored", ok: "yes" }
        expect((Bug.scrub(circ) as Record<string, unknown>).self).toBe("[Circular]")
        expect((Bug.scrub(symObj) as Record<string, unknown>).ok).toBe("yes")

        // 2. ExecutionEnvironment: invalid registry JSON, non-object, relative home, bad dest, duplicate, add/remove errors, aborted run
        const envSrc = { HOME: tmp, XDG_CONFIG_HOME: tmp }
        const regFile = ExecutionEnvironment.registryPath(envSrc)
        await mkdir(dirname(regFile), { recursive: true })
        await writeFile(regFile, "{not json")
        await expect(ExecutionEnvironment.list(envSrc)).rejects.toThrow("valid JSON")
        await writeFile(regFile, JSON.stringify({ version: 1, environments: [null] }))
        await expect(ExecutionEnvironment.list(envSrc)).rejects.toThrow("Invalid execution environment")
        await writeFile(
          regFile,
          JSON.stringify({
            version: 1,
            environments: [{ name: "a", transport: "local", directory: tmp, home: "relative/path" }]
          })
        )
        await expect(ExecutionEnvironment.list(envSrc)).rejects.toThrow("absolute path")
        await writeFile(
          regFile,
          JSON.stringify({
            version: 1,
            environments: [{ name: "a", transport: "ssh", directory: tmp, destination: "-bad" }]
          })
        )
        await expect(ExecutionEnvironment.list(envSrc)).rejects.toThrow("destination")
        await writeFile(
          regFile,
          JSON.stringify({
            version: 1,
            environments: [
              { name: "dup", transport: "local", directory: tmp, home: tmp },
              { name: "dup", transport: "local", directory: tmp, home: tmp }
            ]
          })
        )
        await expect(ExecutionEnvironment.list(envSrc)).rejects.toThrow("Duplicate")
        await writeFile(regFile, JSON.stringify({ version: 1, environments: [] }))
        const localProfile: ExecutionEnvironment.Profile = {
          name: "loc",
          transport: "local",
          directory: tmp,
          home: tmp
        }
        await ExecutionEnvironment.add(localProfile, envSrc)
        await expect(ExecutionEnvironment.add(localProfile, envSrc)).rejects.toThrow("already exists")
        await expect(ExecutionEnvironment.remove("nope", envSrc)).rejects.toThrow("Unknown execution environment")
        const ab = new AbortController()
        ab.abort()
        await expect(
          ExecutionEnvironment.run(localProfile, [process.execPath, "-e", "process.exit(0)"], envSrc, {
            signal: ab.signal
          })
        ).rejects.toThrow()
        const exitCode = await ExecutionEnvironment.run(
          localProfile,
          [process.execPath, "-e", "process.exit(0)"],
          envSrc
        )
        expect(exitCode).toBe(0)

        // 3. Agents: malformed Unicode in codexConfigString + manualInstructions + addMcp with empty PATH
        expect(() => Agents.codexConfigString("\ud800")).toThrow(RangeError)
        expect(Agents.manualInstructions(["claude", "codex"], { HOME: tmp })).toContain("smithers")
        const wired = Agents.addMcp(Agents.agents[0]!, tmp, { HOME: tmp, XDG_CONFIG_HOME: tmp, PATH: "" })
        expect(wired.agent).toBe(Agents.agents[0]!.id)

        // 4. CloudSandbox: 404 delete, 500 delete retry/warn, lease renewal fail warn, wait-running timeout
        let reqMode: "ok-404-del" | "ok-500-del" | "lease-fail" | "stuck-starting" = "ok-404-del"
        let leaseHits = 0
        const server = createServer((req, res) => {
          if (req.method === "DELETE") {
            const code = reqMode === "ok-404-del" ? 404 : 400
            res.writeHead(code, { "content-type": "application/json" })
            res.end(JSON.stringify({ message: "del" }))
            return
          }
          if (req.url?.endsWith("/lease")) {
            leaseHits++
            const fail = reqMode === "lease-fail" && leaseHits > 1
            res.writeHead(fail ? 400 : 200, { "content-type": "application/json" })
            res.end(JSON.stringify({ ok: !fail }))
            return
          }
          if (req.method === "GET" && reqMode === "stuck-starting") {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({ message: "db blip" }))
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ id: "ws-9h", status: reqMode === "stuck-starting" ? "starting" : "running" }))
        })
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
        const port = (server.address() as AddressInfo).port
        try {
          const api = CloudSandbox.workspaceApi({
            SMITHERS_API_ORIGIN: `http://127.0.0.1:${port}`,
            SMITHERS_TOKEN: "test-token"
          })
          const localApi = { request: api.request, sshPrefix: async () => [] }
          for (const m of ["ok-404-del", "ok-500-del"] as const) {
            reqMode = m
            await Effect.runPromise(
              Effect.gen(function*() {
                const spawner = yield* ChildProcessSpawner
                const provider = CloudSandbox.make({
                  spawner,
                  repository: "acme/repo",
                  api: localApi,
                  workdir: tmp,
                  persistence: "ephemeral",
                  pollInterval: "10 millis"
                })
                yield* Effect.scoped(provider.acquire("k1"))
              }).pipe(Effect.provide(NodeServices.layer))
            )
          }
          // Lease fail warning on sticky workspace
          reqMode = "lease-fail"
          await Effect.runPromise(
            Effect.gen(function*() {
              const spawner = yield* ChildProcessSpawner
              const provider = CloudSandbox.make({
                spawner,
                repository: "acme/repo",
                api: localApi,
                workdir: tmp,
                persistence: "sticky",
                clientLeaseSeconds: 60
              })
              const ready = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const fib = yield* Effect.forkChild(Effect.scoped(Effect.gen(function*() {
                yield* provider.acquire("k2")
                yield* Deferred.succeed(ready, undefined)
                yield* Deferred.await(release)
              })))
              yield* Deferred.await(ready)
              yield* TestClock.adjust("25 seconds")
              yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/barrier`))
              yield* Deferred.succeed(release, undefined)
              yield* Fiber.join(fib)
            }).pipe(Effect.provide(TestClock.layer()), Effect.provide(NodeServices.layer))
          )
          // Stuck starting -> timeout with lastReadFailure
          reqMode = "stuck-starting"
          const stuckExit = await Effect.runPromise(
            Effect.exit(
              Effect.gen(function*() {
                const spawner = yield* ChildProcessSpawner
                const provider = CloudSandbox.make({
                  spawner,
                  repository: "acme/repo",
                  api: localApi,
                  workdir: tmp,
                  persistence: "ephemeral",
                  readyTimeout: 50
                })
                yield* Effect.scoped(provider.acquire("k3"))
              }).pipe(Effect.provide(NodeServices.layer))
            )
          )
          expect(Exit.isFailure(stuckExit)).toBe(true)
        } finally {
          server.closeAllConnections()
          await new Promise<void>((r) => server.close(() => r()))
        }

        // 5. runner/Spool: torn line, non-empty without newline, unavailable & refused drain
        const spoolDir = join(tmp, "spool")
        const key = "todo:w9h#g1"
        const file = Spool.fileOf(spoolDir, key)
        mkdirSync(dirname(file), { recursive: true })
        const line0 = JSON.stringify({ seq: 0, at: 1, kind: Transcript.KINDS.turn, update: {} })
        writeFileSync(file, `${line0}\n{"broken`)
        await Effect.runPromise(
          Effect.gen(function*() {
            const sp = yield* Spool.open({ stateDir: spoolDir, key, claim: "c", scrub: (t) => t })
            yield* sp.append(Transcript.KINDS.turn, { text: "a".repeat(20_000) })
            yield* sp.append(Transcript.KINDS.turn, { text: "b".repeat(20_000) })
          }).pipe(Effect.scoped)
        )
        const key2 = "todo:w9h#g2"
        const file2 = Spool.fileOf(spoolDir, key2)
        writeFileSync(file2, line0)
        const refusedHost = Host.Host.of({
          claim: () => Effect.die("u"),
          heartbeat: () => Effect.die("u"),
          settle: () => Effect.die("u"),
          gitCredential: () => Effect.die("u"),
          events: () => Effect.fail(new Host.HostError({ code: "invalid", route: "events", status: 409 }))
        })
        const unavailHost = Host.Host.of({
          claim: () => Effect.die("u"),
          heartbeat: () => Effect.die("u"),
          settle: () => Effect.die("u"),
          gitCredential: () => Effect.die("u"),
          events: () => Effect.fail(new Host.HostError({ code: "unavailable", route: "events" }))
        })
        const refDrained = await Effect.runPromise(
          Effect.gen(function*() {
            const sp = yield* Spool.open({ stateDir: spoolDir, key: key2, claim: "c", scrub: (t) => t })
            yield* sp.append(Transcript.KINDS.turn, { text: "x".repeat(200) })
            return yield* sp.drain
          }).pipe(Effect.scoped, Effect.provideService(Host.Host, refusedHost))
        )
        expect(refDrained).toBe("refused")

        const unavailExit = await Effect.runPromise(
          Effect.exit(
            Effect.gen(function*() {
              const sp = yield* Spool.open({ stateDir: spoolDir, key, claim: "c", scrub: (t) => t })
              return yield* sp.drain
            }).pipe(Effect.scoped, Effect.provideService(Host.Host, unavailHost))
          )
        )
        expect(Exit.isFailure(unavailExit)).toBe(true)
      })
    }
  )

  it(
    "ClaudeCode, CodexLogin, Suggest, Evaluation & EvalCli cover SDK failures, lock races, scan/cancel errors & eval run/commit/compare guards",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9h-eval-", async (tmp) => {
        // 1. ClaudeCode: QueryTransport failure modes
        for (
          const err of [
            new SyntaxError("bad"),
            new TypeError("type"),
            Object.assign(new Error("mod"), { code: "ERR_MODULE_NOT_FOUND" }),
            new Error("other")
          ]
        ) {
          const res = await Effect.runPromise(
            Effect.exit(
              ClaudeCode.load({ model: "haiku", executable: "/nonexistent/claude", environment: {} }).pipe(
                Effect.provideService(ClaudeCode.QueryTransport, Effect.fail(err as never))
              )
            )
          )
          expect(Exit.isFailure(res)).toBe(true)
        }

        // 2. CodexLogin: malformed JWT, stale lock invalid pid, live pid lock released mid-wait, cliRefresh unanswered
        expect(CodexLogin.parse(JSON.stringify({ tokens: { access_token: "only-one-part" } }))).toBeDefined()
        expect(CodexLogin.parse(JSON.stringify({ tokens: { access_token: "a.!!!.c" } }))).toBeDefined()
        const authFile = join(tmp, "codex-auth.json")
        const expPayload = Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")
        await writeFile(authFile, JSON.stringify({ tokens: { access_token: `h.${expPayload}.s`, refresh_token: "r" } }))
        // Stale lock with bad pid "0" and old mtime gets cleaned & proceeds to refresh
        const lockFile = `${authFile}.refresh.lock`
        await writeFile(lockFile, "0\n")
        const oldTime = new Date(Date.now() - 10 * 60_000)
        utimesSync(lockFile, oldTime, oldTime)
        const store = CodexLogin.make({
          file: authFile,
          refresh: Effect.fail(new Error("no refresh") as never)
        })
        const r1 = await Effect.runPromise(Effect.exit(store.auth.sign({})))
        expect(Exit.isFailure(r1)).toBe(true)
        // Live lock held by our pid, removed after 40ms so wait loop polls & recovers cleanly
        await writeFile(lockFile, `${process.pid}\n`)
        const rmTimer = setTimeout(() => {
          rm(lockFile, { force: true }).catch(() => {})
        }, 40)
        try {
          const r2 = await Effect.runPromise(Effect.exit(store.auth.sign({})))
          expect(Exit.isFailure(r2)).toBe(true)
        } finally {
          clearTimeout(rmTimer)
          await rm(lockFile, { force: true })
        }
        // cliRefresh unanswered on failing binary in PATH
        const fakeBin = join(tmp, "fake-bin")
        await mkdir(fakeBin, { recursive: true })
        const badCli = join(fakeBin, "codex")
        await writeFile(badCli, "#!/bin/sh\nexit 1\n")
        chmodSync(badCli, 0o755)
        const refEx = await Effect.runPromise(
          Effect.exit(CodexLogin.cliRefresh({ environment: { HOME: tmp, PATH: fakeBin }, timeoutMs: 500 }))
        )
        expect(Exit.isFailure(refEx)).toBe(true)

        // 3. Suggest: scan failure & exitStatus cancelled
        const badScan = await Effect.runPromise(
          Effect.exit(
            Suggest.run({
              root: join(tmp, "no-such-repo"),
              environment: { HOME: tmp, PATH: "" },
              list: true,
              json: false
            })
          )
        )
        expect(Exit.isFailure(badScan)).toBe(true)
        expect(Suggest.exitStatus({ status: "cancelled", implemented: [], suggestions: [] } as never)).toBe(130)

        // 4. Evaluation & EvalCli: ENOTDIR, hidden/node_modules skip, symlink escape, ambiguous, broken module, invalid run, commit guards, compare output
        const evalRoot = join(tmp, "eval-proj")
        await mkdir(join(evalRoot, "evals", ".hidden"), { recursive: true })
        await mkdir(join(evalRoot, "evals", "node_modules", "x"), { recursive: true })
        await mkdir(join(evalRoot, "evals", "sub"), { recursive: true })
        await writeFile(join(evalRoot, "evals", ".hidden", "skip.eval.ts"), "export default {}")
        await writeFile(join(evalRoot, "evals", "node_modules", "x", "skip.eval.ts"), "export default {}")
        await writeFile(join(evalRoot, "evals", "sub", "broken.eval.mjs"), "throw new Error('broken import')\n")
        const outside = join(tmp, "outside.eval.mjs")
        await writeFile(outside, "export default {}")
        symlinkSync(outside, join(evalRoot, "evals", "escape.eval.mjs"))

        const fileRoot = join(tmp, "file-eval")
        await mkdir(fileRoot, { recursive: true })
        await writeFile(join(fileRoot, "evals"), "not a dir")
        await expect(Evaluation.list(fileRoot)).rejects.toThrow("directory")

        const listed = await Evaluation.list(evalRoot)
        expect(listed.some((s) => s.name.includes("broken"))).toBe(true)
        await expect(Evaluation.load(evalRoot, "evals/sub/broken.eval.mjs")).rejects.toThrow("Could not import")
        await expect(Evaluation.load(evalRoot, "evals/escape.eval.mjs")).rejects.toThrow()
        const ab = new AbortController()
        ab.abort()
        await expect(Evaluation.load(evalRoot, "evals/sub/broken.eval.mjs", { signal: ab.signal } as never)).rejects
          .toThrow()
        await expect(
          Effect.runPromise(Evaluation.publishJson(join(evalRoot, "x.json"), "{}", false, ab.signal))
        ).rejects.toThrow()

        await writeFile(join(evalRoot, "evals", "dup.eval.mjs"), "export default {}")
        await writeFile(join(evalRoot, "evals", "dup.eval.ts"), "export default {}")
        await expect(Evaluation.load(evalRoot, "dup")).rejects.toThrow("Ambiguous")

        const evalCli = EvalCli.createEvalCli({ environment: { HOME: tmp } })
        const runCmd = async (argv: Array<string>) => {
          let out = ""
          const codes: Array<number> = []
          await evalCli.serve(argv, {
            stdout: (t) => {
              out += t
            },
            exit: (c) => {
              codes.push(c)
            }
          })
          return { out, codes }
        }
        const badJsonPath = join(evalRoot, "bad-run.json")
        await writeFile(badJsonPath, "{not valid")
        const badShow = await runCmd(["show", badJsonPath, "--root", evalRoot])
        expect(badShow.codes.some((c) => c !== 0)).toBe(true)

        const incompleteRun = {
          schemaVersion: 1,
          runId: "r-inc",
          suite: { id: "s1", name: "s1", version: "1", cases: [] },
          startedAt: 1,
          completedAt: 2,
          status: "inconclusive",
          cases: [],
          metrics: {}
        }
        const incPath = join(evalRoot, "inc-run.json")
        await writeFile(incPath, JSON.stringify(incompleteRun))
        const comInc = await runCmd(["commit", incPath, "--root", evalRoot])
        expect(comInc.codes.some((c) => c !== 0)).toBe(true)

        const okRun = {
          schemaVersion: 1,
          runId: "r-ok",
          suite: { id: "s1", name: "s1", version: "1", cases: [] },
          startedAt: 1,
          completedAt: 2,
          status: "completed",
          cases: [],
          metrics: {}
        }
        const okPath = join(evalRoot, "ok-run.json")
        await writeFile(okPath, JSON.stringify(okRun))
        await runCmd(["commit", okPath, "--root", evalRoot])
        const comDup = await runCmd(["commit", okPath, "--root", evalRoot])
        expect(comDup.codes.some((c) => c !== 0)).toBe(true)
        const cmpOut = join(evalRoot, "cmp.json")
        await runCmd(["compare", okPath, okPath, "--output", cmpOut, "--root", evalRoot])
      })
    }
  )

  it(
    "Memory, Triggers, TriggerPlans & TargetRuns cover control-char/compact/unknown-id, invalid-JSON/disabled-trigger & target-run lifecycle",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9h-ops-", async (tmp) => {
        // 1. Memory CLI: control char namespace, unknown note/thread, compact dryRun/empty/actual
        const memCli = MemoryCli.createMemoryCli()
        const runMem = async (argv: Array<string>) => {
          let out = ""
          const codes: Array<number> = []
          await memCli.serve(argv, {
            stdout: (t) => {
              out += t
            },
            exit: (c) => {
              codes.push(c)
            }
          })
          return { out, codes }
        }
        const badNs = await runMem(["get", "k1", "--namespace-id", "bad\x00id", "--root", tmp])
        expect(badNs.codes.some((c) => c !== 0)).toBe(true)
        const unkNote = await runMem(["notes", "get", "no-such-note", "--root", tmp])
        expect(unkNote.codes.some((c) => c !== 0)).toBe(true)
        const unkThread = await runMem(["threads", "get", "no-such-thread", "--root", tmp])
        expect(unkThread.codes.some((c) => c !== 0)).toBe(true)

        const mkTh = await runMem(["threads", "create", "--title", "t1", "--root", tmp, "--json"])
        const parsedTh = JSON.parse(mkTh.out) as { id?: string; threadId?: string }
        const threadId = parsedTh.id ?? parsedTh.threadId ?? "t1"
        await runMem(["threads", "append", threadId, "--role", "user", "--text", "msg 1", "--root", tmp])
        await runMem(["threads", "append", threadId, "--role", "assistant", "--text", "msg 2", "--root", tmp])
        await runMem(["threads", "append", threadId, "--role", "user", "--text", "msg 3", "--root", tmp])
        const future = String(Date.now() + 60_000)
        await runMem([
          "threads",
          "compact",
          threadId,
          "--before",
          future,
          "--keep",
          "1",
          "--summary",
          "sum",
          "--dry-run",
          "--root",
          tmp
        ])
        await runMem([
          "threads",
          "compact",
          threadId,
          "--before",
          "1",
          "--keep",
          "10",
          "--summary",
          "sum",
          "--root",
          tmp
        ])
        await runMem([
          "threads",
          "compact",
          threadId,
          "--before",
          future,
          "--keep",
          "1",
          "--summary",
          "sum",
          "--root",
          tmp
        ])

        // 2. Triggers CLI: invalid JSON flag, mismatched file ID, disabled manual fire, enable/disable, fires
        const trigCli = TriggersCli.createTriggersCli()
        const runTrig = async (argv: Array<string>) => {
          let out = ""
          const codes: Array<number> = []
          await trigCli.serve(argv, {
            stdout: (t) => {
              out += t
            },
            exit: (c) => {
              codes.push(c)
            }
          })
          return { out, codes }
        }
        const badJsonTrig = await runTrig([
          "create",
          "t1",
          "--flow",
          "f",
          "--cron",
          "0 * * * *",
          "--input",
          "{bad",
          "--root",
          tmp
        ])
        expect(badJsonTrig.codes.some((c) => c !== 0)).toBe(true)

        const trigFile = join(tmp, "trig.json")
        await writeFile(
          trigFile,
          JSON.stringify({
            id: "other-id",
            flowId: "demo/f",
            schedule: { _tag: "Cron", expression: "0 * * * *", timezone: "UTC" },
            enabled: false
          })
        )
        const mismatch = await runTrig(["create", "t-real", "--file", trigFile, "--root", tmp])
        expect(mismatch.codes.some((c) => c !== 0)).toBe(true)

        await writeFile(
          trigFile,
          JSON.stringify({
            id: "t-real",
            flowId: "demo/f",
            schedule: { _tag: "Cron", expression: "0 * * * *", timezone: "UTC" },
            enabled: false
          })
        )
        await runTrig(["create", "t-real", "--file", trigFile, "--root", tmp])
        const disFire = await runTrig(["fire", "t-real", "--root", tmp])
        expect(disFire.codes.some((c) => c !== 0)).toBe(true)
        await runTrig(["enable", "t-real", "--root", tmp])
        await runTrig(["disable", "t-real", "--root", tmp])
        await runTrig(["fires", "t-real", "--root", tmp])

        // 3. TriggerPlans & TargetRuns: inspect missing + TargetRuns.logOf/isHandle + Scheduler.Runner lifecycle
        expect(await TriggerPlans.inspect(tmp, "no-such-handle")).toBeNull()
        expect(await TargetRuns.inspectRun(tmp, "no-such-handle")).toBeNull()
        expect(TargetRuns.isHandle("target-run:abc")).toBe(true)
        expect(TargetRuns.logOf("target-run:abc")).toContain("abc")

        const cmdLayer = Layer.succeed(TargetRuns.TargetCommand)({
          run: () => Effect.succeed({ exitCode: 0, stdout: "ok", stderr: "" } as never)
        })
        const scope = await Effect.runPromise(Scope.make())
        try {
          const ctx = await Effect.runPromise(
            Layer.buildWithScope(
              TargetRuns.layer(tmp, { leaseMs: 300 }).pipe(
                Layer.provide([cmdLayer, Scheduler.layerNoopRunner()])
              ),
              scope
            )
          )
          const runner = Context.get(ctx, Scheduler.Runner)
          const h = await Effect.runPromise(
            runner.start({ flowId: TargetRuns.flowId, input: { run: ["//:test"] }, idempotencyKey: "k-w9h" })
          )
          expect(TargetRuns.isHandle(h)).toBe(true)
          const st = await Effect.runPromise(runner.inspect(h))
          expect(st).toBeDefined()
          await Effect.runPromise(runner.cancel(h))
        } finally {
          await Effect.runPromise(Scope.close(scope, Exit.void))
        }
      })
    }
  )

  it(
    "RunnerJobs, LocalJobs, Workstreams, commands/Runner & runner/Lane cover validation, job expiry/restarts/steering, workstream projection & lane base",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9h-runner-", async (tmp) => {
        // 1. RunnerJobs: origin-present config error, layerFromEnvironment unset/bad, admitAll .rejected
        const originCfg = join(tmp, "origin-runner.json")
        await writeFile(
          originCfg,
          JSON.stringify({
            name: "r1",
            origin: "https://api.example.test",
            stateDir: join(tmp, "st"),
            capacity: 1,
            repositories: {},
            profiles: {}
          })
        )
        const origExit = await Effect.runPromise(
          Effect.exit(
            Effect.flatMap(AgentRunner.AgentJobs, (j) => j.status("k")).pipe(
              Effect.provide(RunnerJobs.layer(originCfg))
            )
          )
        )
        expect(Exit.isFailure(origExit)).toBe(true)

        const savedCfg = process.env[RunnerJobs.CONFIG_VARIABLE]
        try {
          delete process.env[RunnerJobs.CONFIG_VARIABLE]
          const unsetEx = await Effect.runPromise(
            Effect.exit(
              Effect.flatMap(AgentRunner.AgentJobs, (j) => j.cancel("k")).pipe(
                Effect.provide(RunnerJobs.layerFromEnvironment)
              )
            )
          )
          expect(Exit.isFailure(unsetEx)).toBe(true)

          process.env[RunnerJobs.CONFIG_VARIABLE] = join(tmp, "nonexistent-runner.json")
          const badEx = await Effect.runPromise(
            Effect.exit(
              Effect.flatMap(AgentRunner.AgentJobs, (j) => j.status("k")).pipe(
                Effect.provide(RunnerJobs.layerFromEnvironment)
              )
            )
          )
          expect(Exit.isFailure(badEx)).toBe(true)
        } finally {
          if (savedCfg === undefined) delete process.env[RunnerJobs.CONFIG_VARIABLE]
          else process.env[RunnerJobs.CONFIG_VARIABLE] = savedCfg
        }

        // admitAll rejects malformed request file -> renames to .rejected
        const stDir = join(tmp, "rj-state")
        const rjPaths = RunnerJobs.paths(stDir)
        const badReqPath = rjPaths.request("bad", "start")
        await mkdir(dirname(badReqPath), { recursive: true })
        await writeFile(badReqPath, "{corrupt")
        await Effect.runPromise(
          Effect.gen(function*() {
            const localStore = yield* LocalJobs.make(stDir)
            yield* RunnerJobs.admitAll(stDir, localStore.jobs)
            expect(readFileSync(`${badReqPath}.rejected`, "utf8")).toBe("{corrupt")

            // 2. LocalJobs: free===0 -> null, unknown key heartbeat/events 409, gitCredential 404
            expect(yield* localStore.host.claim({ profiles: ["p"], free: 0, running: [], waitSeconds: 1 })).toBeNull()
            const hbMissing = yield* localStore.host.heartbeat({ key: "missing", claim: "c", delivered: [] })
            expect(hbMissing.held).toBe(false)
            const evMissing = yield* Effect.exit(localStore.host.events({ key: "missing", claim: "c", events: [] }))
            expect(Exit.isFailure(evMissing)).toBe(true)
            const gitMissing = yield* Effect.exit(localStore.host.gitCredential({ key: "missing", claim: "c" }))
            expect(Exit.isFailure(gitMissing)).toBe(true)
          }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
        )

        // 3. Workstreams.project (including undeclared workstream) + Workstreams.read (queued + admitted)
        const proj = Workstreams.project({}, [{
          request: "req-1",
          task: { workstream: "adhoc", id: "t1", title: "Task 1" },
          profile: "claude",
          standing: false,
          runId: "run-1",
          status: "running"
        }])
        expect(proj[0]!.id).toBe("adhoc")

        const lanes = Lanes.make()
        try {
          const brief = join(tmp, "brief.md")
          await writeFile(brief, "do work\n")
          for (
            const opts of [
              { brief, config: lanes.configPath, profile: "p", repo: "r", maxHours: 0 },
              { brief, config: lanes.configPath, profile: "p", repo: "r", restarts: -1 },
              { brief, config: lanes.configPath, profile: "p", repo: "r", workstream: "w1" },
              { brief, config: lanes.configPath, profile: "p", repo: "r", workstream: "w1", task: "BAD_TASK" }
            ]
          ) {
            const ex = await Effect.runPromise(
              Effect.exit(RunnerCmd.start(opts as never).pipe(Effect.provide(NodeServices.layer)))
            )
            expect(Exit.isFailure(ex)).toBe(true)
          }

          const cfg = await Effect.runPromise(Config.load(lanes.configPath).pipe(Effect.provide(NodeServices.layer)))
          const intake = LaneIntake.paths(cfg.stateDir)
          const aid = "00000000-0000-4000-8000-000000000001"
          const admittedFile = intake.admitted(aid)
          await mkdir(dirname(admittedFile), { recursive: true })
          await writeFile(
            admittedFile,
            JSON.stringify({
              id: aid,
              runId: "r-missing",
              profile: "claude",
              standing: false,
              task: { workstream: "w1", id: "t1" }
            })
          )
          const wsRead = await Effect.runPromise(
            Workstreams.read(cfg, Layer.orDie(TestControl.layer({ now: () => 0, flows: [] }))).pipe(
              Effect.provide(NodeServices.layer)
            )
          )
          expect(wsRead.length).toBeGreaterThanOrEqual(1)

          // 4. runner/Lane.Base action call
          const baseNode = Lane.Base.call({ repository: "unknown-repo", follow: "main", last: "abc123" })
          expect(baseNode).toBeDefined()
        } finally {
          await lanes.close()
        }
      })
    }
  )
})
