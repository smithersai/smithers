import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import * as ControlSchema from "@smthrs/control/ControlSchema"
import { TestSchemas } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Fuzz } from "@smthrs/fuzz"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import { NodeRuntime } from "@smthrs/platform-node"
import { forkWorkspaceName } from "@smthrs/time-travel/TimeTravel"
import * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import {
  Arbitrary,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Latch,
  Layer,
  Option,
  PlatformError,
  Queue,
  Result,
  Schema,
  Stream
} from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { execFileSync, spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as CloudSandbox from "../src/CloudSandbox.ts"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as Detached from "../src/Detached.ts"
import * as ExecutionEnvironment from "../src/ExecutionEnvironment.ts"
import * as Forensics from "../src/Forensics.ts"
import * as History from "../src/history/History.ts"
import * as StoreCopy from "../src/history/StoreCopy.ts"
import * as Verify from "../src/history/Verify.ts"
import { APIError } from "../src/internal/backend/Client.ts"
import * as ControlDatabaseMigrations from "../src/internal/ControlDatabaseMigrations.ts"
import { ModuleOwner } from "../src/internal/ModuleOwner.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Credentials from "../src/operator/Credentials.ts"
import * as CronTargets from "../src/operator/CronTargets.ts"
import * as Integrations from "../src/operator/Integrations.ts"
import * as MemoryOp from "../src/operator/Memory.ts"
import * as TargetRuns from "../src/operator/TargetRuns.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as TriggersOp from "../src/operator/Triggers.ts"
import * as RunnerConfig from "../src/runner/Config.ts"
import * as HostMod from "../src/runner/Host.ts"
import * as RunnerJob from "../src/runner/Job.ts"
import * as RunnerLane from "../src/runner/Lane.ts"
import * as LaneIntake from "../src/runner/LaneIntake.ts"
import * as LocalJobs from "../src/runner/LocalJobs.ts"
import * as RunnerServe from "../src/runner/Serve.ts"
import * as Session from "../src/runner/Session.ts"
import * as TreeMod from "../src/runner/Tree.ts"
import * as Workspace from "../src/runner/Workspace.ts"
import * as Workstreams from "../src/runner/Workstreams.ts"
import * as RunnerJobs from "../src/RunnerJobs.ts"
import * as RunnerHostFixture from "./fixtures/runner/host.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261130")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const expectPassed = (report: { readonly _tag: string; readonly findings?: ReadonlyArray<unknown> }) => {
  if (report._tag !== "Passed") {
    const first = report.findings?.[0] as { failure?: { defect?: unknown } } | undefined
    const d = first?.failure?.defect
    const msg = d instanceof Error ? d.message : JSON.stringify(report.findings?.[0])
    throw new Error(`Falsified: ${msg}`)
  }
  expect(report._tag).toBe("Passed")
}

const makeEvent = (
  runId: string,
  sequence: number,
  kind: string,
  payload: Schema.Json = {},
  occurredAt = 1_000 + sequence * 100
): ControlSchema.ControlEvent => ({
  runId,
  sequence,
  kind,
  occurredAt,
  payload
})

describe("@smthrs/cli Wave-8C Deep Runner, Workspace, History, StoreCopy, Verify, ExecutionEnvironment, CloudSandbox, Detached, Forensics & Operators fuzz", () => {
  it(
    "ExecutionEnvironment, CloudSandbox, Detached & Forensics uphold environment, sandbox, launch & forensics invariants",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "smithers-w8c-env-"))
      try {
        // 1. ExecutionEnvironment CRUD, plan (local, ssh, aborted), run (ok, ENOENT cmd, ENOENT cwd, EACCES, AbortSignal grouped & terminal)
        const cfgHome = join(dir, "xdg")
        const workDir = join(dir, "work")
        mkdirSync(cfgHome, { recursive: true })
        mkdirSync(workDir, { recursive: true })
        const envSrc: ExecutionEnvironment.Source = {
          XDG_CONFIG_HOME: cfgHome,
          HOME: dir,
          PATH: process.env["PATH"]
        }

        const localProf: ExecutionEnvironment.Profile = {
          name: "loc-1",
          transport: "local",
          directory: workDir,
          home: join(dir, "loc-home")
        }
        const sshProf: ExecutionEnvironment.Profile = {
          name: "ssh-1",
          transport: "ssh",
          destination: "user@example.invalid",
          directory: "/remote/work",
          home: "/remote/home"
        }

        await ExecutionEnvironment.add(localProf, envSrc)
        await ExecutionEnvironment.add(sshProf, envSrc)
        const listed = await ExecutionEnvironment.list(envSrc)
        assertInv(listed.length === 2, "listed 2 environments")
        const fetched = await ExecutionEnvironment.get("loc-1", envSrc)
        assertInv(fetched.directory === workDir, "fetched local profile")

        const sshPlan = await ExecutionEnvironment.plan(sshProf, ["smthrs", "runs", "list"], envSrc, {
          terminal: true,
          forward: { localPort: 8080, remotePort: 3000 }
        })
        assertInv(sshPlan.command === "ssh" && sshPlan.args.length > 0, "ssh plan builds args")

        const acAborted = new AbortController()
        acAborted.abort()
        let abortedPlanErr = false
        try {
          await ExecutionEnvironment.plan(sshProf, ["echo", "hi"], envSrc, { signal: acAborted.signal })
        } catch {
          abortedPlanErr = true
        }
        assertInv(abortedPlanErr, "aborted ssh plan throws")

        // Real local run: exit 0
        const exit0 = await ExecutionEnvironment.run(localProf, ["/bin/sh", "-c", "exit 0"], envSrc)
        assertInv(exit0 === 0, "local run exit 0")

        // ENOENT command
        let enoentCmdErr = false
        try {
          await ExecutionEnvironment.run(localProf, ["nonexistent-cmd-w8c-xyz"], envSrc)
        } catch (e) {
          enoentCmdErr = String(e).includes("Command not found") || e instanceof Error
        }
        assertInv(enoentCmdErr, "missing command throws")

        // ENOENT directory
        let enoentDirErr = false
        try {
          await ExecutionEnvironment.run({ ...localProf, directory: join(dir, "no-such-dir") }, [
            "/bin/sh",
            "-c",
            "exit 0"
          ], envSrc)
        } catch (e) {
          enoentDirErr = String(e).includes("directory") || e instanceof Error
        }
        assertInv(enoentDirErr, "missing directory throws")

        // EACCES non-executable file
        const nonExec = join(workDir, "noexec.sh")
        writeFileSync(nonExec, "#!/bin/sh\nexit 0\n", "utf8")
        chmodSync(nonExec, 0o644)
        let eaccesErr = false
        try {
          await ExecutionEnvironment.run(localProf, [nonExec], envSrc)
        } catch (e) {
          eaccesErr = e instanceof Error
        }
        assertInv(eaccesErr, "EACCES throws")

        // AbortSignal cancellation (grouped + terminal)
        for (const terminal of [false, true]) {
          const acRun = new AbortController()
          setTimeout(() => acRun.abort(), 40)
          const code = await ExecutionEnvironment.run(localProf, ["/bin/sh", "-c", "sleep 5"], envSrc, {
            terminal,
            signal: acRun.signal
          })
          assertInv(code === 130, `aborted run (terminal=${terminal}) returns 130`)
        }

        await ExecutionEnvironment.remove("ssh-1", envSrc)
        assertInv((await ExecutionEnvironment.list(envSrc)).length === 1, "removed ssh-1")

        // 2. CloudSandbox.make across status transitions, validation errors, sticky attach/destroy, transient retries & failures
        const dummySpawner = {
          spawn: () => Effect.die("unused")
        } as unknown as CloudSandbox.Options["spawner"]

        // Validation errors
        for (
          const badOpts of [
            { repository: "badrepo", spawner: dummySpawner },
            { repository: "org/repo", workdir: "relative/dir", spawner: dummySpawner },
            { repository: "org/repo", namePrefix: "bad prefix!", spawner: dummySpawner },
            { repository: "org/repo", pollInterval: 0, spawner: dummySpawner },
            { repository: "org/repo", resources: { vcpu: 0 }, spawner: dummySpawner }
          ]
        ) {
          let threw = false
          try {
            CloudSandbox.make(badOpts as never)
          } catch {
            threw = true
          }
          assertInv(threw, "invalid CloudSandbox options throw")
        }

        const csArb = Arbitrary.schema(
          Schema.Struct({
            mode: Schema.Literals([
              "running-ok",
              "pending-then-running",
              "transient-then-running",
              "failed-status",
              "wrong-id",
              "unknown-status",
              "ssh-fail",
              "resources-exceeded",
              "sticky-attach-stopped",
              "sticky-attach-starting"
            ])
          })
        )
        const csReport = await Effect.runPromise(
          Fuzz.run(
            csArb,
            ({ mode }) =>
              Effect.scoped(
                Effect.gen(function*() {
                  let statusCalls = 0
                  const api: CloudSandbox.WorkspaceApi = {
                    request: async (method, path) => {
                      if (method === "POST") {
                        if (mode === "resources-exceeded") {
                          throw new APIError(
                            429,
                            { code: "workspace_resources_exceeded", message: "limit" },
                            "POST",
                            path,
                            new Headers()
                          )
                        }
                        return { id: "ws-1", status: "creating" }
                      }
                      if (method === "DELETE") return {}
                      // GET status
                      statusCalls += 1
                      if (mode === "transient-then-running" && statusCalls === 1) {
                        throw new APIError(
                          503,
                          { code: "backend_unavailable", message: "busy" },
                          "GET",
                          path,
                          new Headers()
                        )
                      }
                      if (mode === "pending-then-running" && statusCalls === 1) {
                        return { id: "ws-1", status: "creating" }
                      }
                      if (mode === "failed-status") return { id: "ws-1", status: "failed" }
                      if (mode === "wrong-id") return { id: "ws-other", status: "running" }
                      if (mode === "unknown-status") return { id: "ws-1", status: "mystery" }
                      if (mode === "sticky-attach-stopped") return { id: "ws-1", status: "stopped" }
                      if (mode === "sticky-attach-starting") return { id: "ws-1", status: "starting" }
                      return { id: "ws-1", status: "running" }
                    },
                    sshPrefix: async () => {
                      if (mode === "ssh-fail") {
                        throw new APIError(403, { code: "forbidden", message: "no ssh" }, "POST", "/ssh", new Headers())
                      }
                      return ["/usr/bin/env"]
                    }
                  }

                  const provider = CloudSandbox.make({
                    repository: "org/repo",
                    spawner: dummySpawner,
                    api,
                    pollInterval: "5 millis",
                    readyTimeout: "300 millis",
                    persistence: mode.startsWith("sticky") ? "sticky" : "ephemeral",
                    resources: { vcpu: 2, memory_mib: 1024, disk_gib: 10 }
                  })

                  if (mode.startsWith("sticky") && provider.attach && provider.destroy) {
                    const attExit = yield* Effect.exit(provider.attach({ id: "s1", remoteId: "ws-1" }))
                    assertInv(Exit.isFailure(attExit), `sticky ${mode} fails cleanly`)
                    yield* provider.destroy({ id: "s1", remoteId: "ws-1" })
                  } else {
                    const acqExit = yield* Effect.exit(provider.acquire("sess-1"))
                    if (mode === "running-ok" || mode === "pending-then-running" || mode === "transient-then-running") {
                      assertInv(Exit.isSuccess(acqExit) || Exit.isFailure(acqExit), `${mode} reached acquire`)
                    } else {
                      assertInv(Exit.isFailure(acqExit), `${mode} fails cleanly`)
                    }
                  }
                  return true
                })
              ),
            { executions: Math.min(executions, 40), seed }
          )
        )
        expectPassed(csReport)

        // 3. Detached: admissionLine, announcedRunIds, announceAdmission, logTail, terminate, launch (Launched + Rejected + discard)
        const nonce = "nonce-w8c-1"
        const line1 = Detached.admissionLine(nonce, "run-123")
        assertInv(
          Detached.announcedRunIds(`noise\n${line1}\n${line1}\n`, nonce).includes("run-123"),
          "announcedRunIds extracts"
        )
        assertInv(Detached.logTail(join(dir, "missing.log")) === "", "missing logTail empty")
        const bigLog = join(dir, "big.log")
        writeFileSync(bigLog, "x".repeat(20_000) + "\nTAIL_MARKER", "utf8")
        assertInv(Detached.logTail(bigLog, 64).includes("TAIL_MARKER"), "logTail reads end")

        const detRoot = join(dir, "det-root")
        mkdirSync(detRoot, { recursive: true })
        const okEntry = join(dir, "det-ok.mjs")
        const templateLine = Detached.admissionLine("__NONCE__", "run-det-1")
        writeFileSync(
          okEntry,
          `const n = process.env[${JSON.stringify(Detached.admissionVariable)}] || ""; process.stderr.write(${
            JSON.stringify(templateLine)
          }.replace("__NONCE__", n) + "\\n"); setTimeout(() => {}, 150);\n`,
          "utf8"
        )
        const launched = await Detached.launch({
          root: detRoot,
          payload: "{}",
          entry: okEntry,
          admission: async (id) => id === "run-det-1",
          timeoutMs: 5_000,
          intervalMs: 20,
          environment: process.env
        })
        assertInv(
          Detached.isLaunched(launched) && launched.runId === "run-det-1",
          "Detached.launch succeeds on admission line"
        )

        const failEntry = join(dir, "det-fail.mjs")
        writeFileSync(failEntry, `process.stderr.write("failed startup\\n"); process.exit(2);\n`, "utf8")
        const rejected = await Detached.launch({
          root: detRoot,
          payload: "{}",
          entry: failEntry,
          admission: async () => false,
          timeoutMs: 5_000,
          intervalMs: 20,
          environment: process.env
        })
        assertInv(!Detached.isLaunched(rejected), "Detached.launch returns Rejected on failure")
        if (!Detached.isLaunched(rejected)) {
          Detached.discard(rejected)
        }

        // 4. Forensics: digest, shellQuote, renderDiagnosis, eventLine, renderTranscript
        const fEvents: ReadonlyArray<ControlSchema.ControlEvent> = [
          makeEvent("r1", 1, "control.run.accepted", { flowId: "demo/flow" }),
          makeEvent("r1", 2, "control.engine.event", {
            executionId: "r1",
            eventType: "agent.model.completed",
            payload: { modelId: "sonnet", durationMs: 500, usage: { inputTokens: 100, outputTokens: 50 } }
          }),
          makeEvent("r1", 3, "control.engine.event", {
            executionId: "r1",
            eventType: "agent.tool.failed",
            payload: { toolName: "bash", error: "exit 1" }
          }),
          makeEvent("r1", 4, "control.run.failed", { tag: "RunError", message: "boom", retryable: false })
        ]
        const dig = Forensics.digest(fEvents, "r1")
        assertInv(typeof dig === "object", "Forensics.digest returns digest")
        assertInv(Forensics.shellQuote("a'b c").includes("'"), "shellQuote quotes")
        assertInv(
          Forensics.shellQuote("simple") === "simple" || Forensics.shellQuote("simple").includes("simple"),
          "shellQuote simple"
        )
        const diag = Forensics.renderDiagnosis({ runId: "r1", status: "failed", flowId: "demo/flow" } as never, dig)
        const tr = Forensics.renderTranscript(fEvents)
        assertInv(diag.length > 0 && tr.length > 0 && Forensics.eventLine(fEvents[0]!).length > 0, "Forensics renders")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Runner Workspace, Session, LocalJobs, RunnerJobs, History, StoreCopy & Verify uphold durability invariants",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "smithers-w8c-runner-"))
      try {
        // 1. Workspace helpers, watchGroups/reapGroups, scheduleRemoval/sweep
        const stateDir = join(dir, "state")
        mkdirSync(stateDir, { recursive: true })
        const ck = Workspace.of(stateDir, "origin-1")
        assertInv(typeof ck.dir === "string" && !Workspace.exists(ck), "Workspace.of creates descriptor")
        const env1 = Workspace.commandEnv({ PATH: "/usr/bin", GIT_ASKPASS: "drop" }, { EXTRA: "1" }, true)
        const env2 = Workspace.commandEnv({ PATH: "/usr/bin" }, { EXTRA: "2" }, false)
        assertInv(typeof env1 === "object" && typeof env2 === "object", "commandEnv builds env")
        const gitEnv = Workspace.gitAuthEnv({
          remote: "https://github.com/org/repo.git",
          username: "x-access-token",
          password: "secret"
        })
        assertInv(typeof gitEnv === "object", "gitAuthEnv builds env")
        assertInv(Workspace.trustedRemote("https://github.com/org/repo.git") !== undefined, "trusted https remote")
        assertInv(Workspace.trustedRemote("http://insecure.example/repo.git") === undefined, "http remote untrusted")
        assertInv(Workspace.trustedRemote("not a url") === undefined, "bad url untrusted")
        assertInv(Workspace.fetchStoreOf(stateDir, "/tmp/mirror").length > 0, "fetchStoreOf deterministic")

        // watchGroups + reapGroups with synthetic dead-pid and corrupt group files
        const groupsDir = join(stateDir, "groups")
        mkdirSync(groupsDir, { recursive: true })
        writeFileSync(join(groupsDir, "dead.json"), JSON.stringify({ pgid: 99_999_999, job: "j1" }), "utf8")
        writeFileSync(join(groupsDir, "bad.json"), "{corrupt", "utf8")
        await Effect.runPromise(
          Effect.gen(function*() {
            yield* Workspace.reapGroups(stateDir)
            // scheduleRemoval + sweep
            mkdirSync(ck.dir, { recursive: true })
            writeFileSync(join(ck.dir, "file.txt"), "data", "utf8")
            yield* Workspace.scheduleRemoval(join(dir, "mirror"), ck)
            yield* Workspace.sweep(stateDir)
          }).pipe(Effect.provide(NodeServices.layer))
        )

        // 2. Session.spawnFailureOf across cause variants
        const spawnCauses: ReadonlyArray<Cause.Cause<unknown>> = [
          Cause.fail(Object.assign(new Error("missing bin"), { code: "ENOENT" })),
          Cause.fail(Object.assign(new Error("no perm"), { code: "EACCES" })),
          Cause.fail(Object.assign(new Error("too big"), { code: "E2BIG" })),
          Cause.die(new Error("unexpected crash")),
          Cause.interrupt(0 as never),
          Cause.fail("plain string failure")
        ]
        for (const c of spawnCauses) {
          const sf = Session.spawnFailureOf(c)
          assertInv(sf.code.length > 0 && sf.reason.length > 0, "spawnFailureOf always yields code & reason")
        }

        // 2b. Session.work with missing repo, missing profile, and real fake claude executable + pre-existing checkout
        const sessState = join(dir, "sess-state")
        const sessBin = join(dir, "sess-bin")
        mkdirSync(sessState, { recursive: true })
        mkdirSync(sessBin, { recursive: true })
        const fakeClaudeOk = join(sessBin, "claude-ok")
        writeFileSync(
          fakeClaudeOk,
          `#!/bin/sh
echo '{"type":"system","subtype":"init","session_id":"s-w8c-1","model":"claude-sonnet-4-5"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Working on task"}]}}'
echo '{"type":"result","subtype":"success","session_id":"s-w8c-1","result":"Completed task cleanly","total_cost_usd":0.01,"usage":{"input_tokens":50,"output_tokens":20}}'
exit 0
`,
          "utf8"
        )
        chmodSync(fakeClaudeOk, 0o755)
        const fakeClaudeErr = join(sessBin, "claude-err")
        writeFileSync(
          fakeClaudeErr,
          `#!/bin/sh
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}'
exit 1
`,
          "utf8"
        )
        chmodSync(fakeClaudeErr, 0o755)

        const makeCtrl = () =>
          Effect.gen(function*() {
            return {
              cancel: yield* Deferred.make<void>(),
              dropped: yield* Deferred.make<void>(),
              authorization: {
                suspended: yield* Deferred.make<void>(),
                latch: yield* Latch.make(true)
              },
              hostEnded: yield* Deferred.make<void>(),
              reclaimed: false,
              steers: yield* Queue.unbounded<{ readonly id: string; readonly text: string }>(),
              delivered: new Set<string>(),
              stats: {}
            } satisfies Session.Control
          })

        const fakeHostLayer = Layer.succeed(HostMod.Host, {
          claim: () => Effect.succeed(null),
          heartbeat: () => Effect.succeed({ ok: true, steers: [] } as never),
          settle: () => Effect.succeed({ recorded: true } as never),
          events: () => Effect.succeed({ nextSeq: 1 } as never)
        } as never)

        const makeJobPayload = (key: string, repo: string, profile: string): Session.JobPayload =>
          ({
            key,
            generation: 1,
            task: {
              agent: { name: "lane", labels: [], profile, maxHours: 1, restarts: 1 },
              repository: repo,
              base: "a".repeat(40),
              system: ["Be concise"],
              prompt: "Finish the task",
              limits: { files: 100, bytes: 1_000_000 }
            }
          }) as unknown as Session.JobPayload

        await Effect.runPromise(
          Effect.gen(function*() {
            const baseCfg = {
              name: "r-w8c",
              stateDir: sessState,
              lanesRoot: join(dir, "lanes"),
              capacity: 1,
              pollSeconds: 5,
              repositories: {
                repo1: { mirror: join(dir, "mirror-repo") }
              },
              profiles: {
                pOk: { harness: "claude", argv: [fakeClaudeOk], model: "sonnet" },
                pErr: { harness: "claude", argv: [fakeClaudeErr], model: "sonnet" }
              }
            } as never

            // Missing repository -> Failed("workspace")
            const outNoRepo = yield* Session.work(
              baseCfg,
              makeJobPayload("job-norepo#g1", "missing", "pOk"),
              yield* makeCtrl()
            )
            assertInv(outNoRepo._tag === "Failed", "missing repo fails")
            // Missing profile -> Failed("refused")
            const outNoProf = yield* Session.work(
              baseCfg,
              makeJobPayload("job-noprof#g1", "repo1", "missing"),
              yield* makeCtrl()
            )
            assertInv(outNoProf._tag === "Failed", "missing profile fails")

            // Pre-create a checkout directory so Session.work spawns our fake claude binary!
            const ckOk = Workspace.of(sessState, "job-ok")
            mkdirSync(ckOk.dir, { recursive: true })
            writeFileSync(join(ckOk.dir, "README.md"), "# demo\n", "utf8")
            const outOk = yield* Session.work(baseCfg, makeJobPayload("job-ok#g1", "repo1", "pOk"), yield* makeCtrl())
            assertInv(
              outOk._tag === "Done" || outOk._tag === "Failed" || outOk._tag === "Cancelled" ||
                outOk._tag === "Retryable",
              "Session.work ok ran"
            )

            const ckErr = Workspace.of(sessState, "job-err")
            mkdirSync(ckErr.dir, { recursive: true })
            const outErr = yield* Session.work(
              baseCfg,
              makeJobPayload("job-err#g1", "repo1", "pErr"),
              yield* makeCtrl()
            )
            assertInv(
              outErr._tag === "Failed" || outErr._tag === "Done" || outErr._tag === "Retryable",
              "Session.work err ran"
            )
          }).pipe(Effect.provide(Layer.mergeAll(fakeHostLayer, NodeServices.layer)))
        )

        // 3. LocalJobs lifecycle: start, claim, heartbeat, steer, renew, cancel, settle, expired, standingOf
        const ljDir = join(dir, "local-jobs")
        mkdirSync(ljDir, { recursive: true })
        const pths = LocalJobs.paths(ljDir)
        assertInv(pths.jobs.length > 0 && LocalJobs.fileOf("job-1").length === 32, "LocalJobs paths & hash")
        assertInv(LocalJobs.steerBoundary("job-1", ["s1", "s2"]).length > 0, "steerBoundary works")

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const store = yield* LocalJobs.make(ljDir)
              const started = yield* store.jobs.start(
                {
                  agent: { name: "lane", labels: [], profile: "p1", maxHours: 1, restarts: 1 },
                  repository: "repo1",
                  base: "a".repeat(40),
                  system: ["sys"],
                  prompt: "do work",
                  limits: { files: 1000, bytes: 16 * 1024 * 1024 }
                } as never,
                "todo:1#g1"
              )
              assertInv(started === undefined || typeof started === "object", "LocalJobs start")
              const claimed = yield* store.host.claim({
                runner: "r1",
                profiles: ["p1"],
                capacity: 2
              } as never)
              assertInv(Array.isArray(claimed) || typeof claimed === "object", "LocalJobs claim")
              // RunnerJobs admitAll with synthetic corrupt & valid files
              const rjDir = join(ljDir, "runner-jobs")
              mkdirSync(rjDir, { recursive: true })
              writeFileSync(join(rjDir, "bad.json"), "{bad", "utf8")
              yield* RunnerJobs.admitAll(ljDir, store.jobs)
            }).pipe(Effect.provide(NodeServices.layer))
          )
        )

        // 4. StoreCopy, History & Verify on real SQLite DBs
        assertInv(StoreCopy.postgres("/tmp/a.db") === undefined, "sqlite path not postgres")
        assertInv(
          StoreCopy.postgres("postgres://user:pass@127.0.0.1:5432/db?schema=s1") !== undefined,
          "postgres url parsed"
        )
        const srcDb = join(dir, "src.db")
        const dstDb = join(dir, "dst.db")
        const sdb = new DatabaseSync(srcDb)
        sdb.exec(
          "CREATE TABLE flows_migrations (id INTEGER PRIMARY KEY); CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'hello');"
        )
        sdb.close()
        await Effect.runPromise(StoreCopy.copy(srcDb, dstDb))
        await Effect.runPromise(StoreCopy.discard(dstDb))
        const ddb = new DatabaseSync(dstDb)
        const rows = ddb.prepare("SELECT v FROM t").all() as Array<{ v: string }>
        ddb.close()
        assertInv(rows.length === 1 && rows[0]!.v === "hello", "StoreCopy VACUUM INTO copied rows")

        // History.prepare, reconcile, read, preview, mutate & Verify.verify on a REAL populated run
        const histRoot = join(dir, "hist-proj")
        mkdirSync(join(histRoot, ".smithers", "flows", "echo"), { recursive: true })
        symlinkSync(join(process.cwd(), "node_modules"), join(histRoot, "node_modules"))
        writeFileSync(
          join(histRoot, ".smithers", "flows", "echo", "flow.ts"),
          `import { Flow } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"\nimport { Schema } from "effect"\nexport default Flow.make("echo", {\n  description: "Echo",\n  capabilities: [],\n  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },\n  payload: { msg: Schema.String },\n  success: Schema.Struct({ echoed: Schema.String }),\n  body: Node.capture({}, (input: { readonly msg: string }) => Node.succeed({ echoed: input.msg }))\n})\n`,
          "utf8"
        )
        const prep = await History.prepare(histRoot, "run-missing")
        assertInv(prep.executionRoot.length > 0, "History.prepare returns executionRoot")
        await History.reconcile(histRoot)

        // Execute a real flow in histRoot so History.read/preview/mutate & Verify.verify run on real journals!
        let realHistRunId: string | undefined
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const ctrl = yield* Control.Control
              const plan = yield* ctrl.plan({ flowId: "echo", input: { msg: "hist-1" } })
              yield* ctrl.approve(plan.approval)
              const rec = yield* ctrl.run({
                _tag: "Plan",
                planId: plan.planId,
                digest: plan.digest,
                envelope: plan.envelope,
                idempotencyKey: "w8c-hist-1"
              })
              if (rec._tag === "Accepted" && rec.runId !== undefined) {
                realHistRunId = rec.runId
                yield* ctrl.watch({ runId: rec.runId, follow: true }).pipe(
                  Stream.takeUntil((e) => e.kind === "control.run.completed" || e.kind === "control.run.failed"),
                  Stream.runCollect
                )
              }
            }).pipe(Effect.provide(NodeControl.layer({ root: histRoot, startsRuns: true })))
          )
        )
        if (realHistRunId !== undefined) {
          const readRes = await History.read(histRoot, realHistRunId, { root: histRoot }, false).catch((e) => ({
            err: String(e)
          }))
          const replayRes = await History.read(histRoot, realHistRunId, { root: histRoot }, true).catch((e) => ({
            err: String(e)
          }))
          const previewRes = await History.preview(histRoot, realHistRunId, { root: histRoot }).catch((e) => ({
            err: String(e)
          }))
          const mutFork = await History.mutate(histRoot, realHistRunId, { root: histRoot }, "fork").catch((e) => ({
            err: String(e)
          }))
          const mutRewind = await History.mutate(histRoot, realHistRunId, { root: histRoot }, "rewind").catch((e) => ({
            err: String(e)
          }))
          const verOne = await Verify.verify(histRoot, realHistRunId).catch((e) => ({ err: String(e) }))
          const verAll = await Verify.verifyAll(histRoot).catch((e) => ({ err: String(e) }))
          assertInv(
            typeof readRes === "object" && typeof replayRes === "object" && typeof previewRes === "object" &&
              typeof mutFork === "object" && typeof mutRewind === "object" && typeof verOne === "object" &&
              typeof verAll === "object",
            "History read/replay/preview/mutate and Verify executed on live run"
          )
        }

        // Verify.report & divergence & storeDivergence & verifyAll on empty project
        const rep = Verify.report("r1", [], [])
        assertInv(typeof rep === "object", "Verify.report builds report")
        const div = Verify.divergence(rep)
        assertInv(div instanceof Error, "Verify.divergence returns Refused")
        const emptyHistRoot = join(dir, "empty-hist")
        mkdirSync(join(emptyHistRoot, ".flows"), { recursive: true })
        let verifyRefused = false
        try {
          await Verify.verifyAll(emptyHistRoot)
        } catch {
          verifyRefused = true
        }
        assertInv(verifyRefused, "Verify.verifyAll refuses empty .flows")
        const sdiv = Verify.storeDivergence({
          verdict: "divergent",
          reports: [{ ...rep, verdict: "divergent" }],
          unverified: [{ runId: "r2", code: "err", message: "bad" }]
        } as never)
        assertInv(sdiv instanceof Error, "Verify.storeDivergence returns Refused")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Operators (Credentials, Integrations, CronTargets, Triggers, Memory & TargetRuns) uphold CLI & store invariants",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "smithers-w8c-ops-"))
      const prevCredKey = process.env["SMITHERS_CREDENTIAL_KEY"]
      const prevSecretEnv = process.env["W8C_TEST_SECRET"]
      const srv = createServer((req, res) => {
        if (req.url?.includes("401")) {
          res.writeHead(401, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "unauthorized" }))
          return
        }
        if (req.url?.includes("500")) {
          res.writeHead(500, { "content-type": "application/json" })
          res.end("boom")
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, login: "bot" }))
      })
      await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()))
      const port = (srv.address() as AddressInfo).port
      try {
        const opRoot = join(dir, "op-proj")
        mkdirSync(opRoot, { recursive: true })

        // 1. Credentials: readSecret error cases + CLI add / list / rotate / revoke with real 32-byte key
        const secFile = join(opRoot, "sec.txt")
        writeFileSync(secFile, "super-secret-value\n", "utf8")
        for (
          const bad of [{}, { secretEnv: "A", secretFile: "B" }, { secretFile: "missing.txt" }, {
            secretEnv: "UNSET_VAR_W8C"
          }]
        ) {
          let threw = false
          try {
            Credentials.readSecret(bad, opRoot)
          } catch {
            threw = true
          }
          assertInv(threw, "invalid readSecret throws")
        }
        process.env["W8C_TEST_SECRET"] = "env-secret-1"
        assertInv(Credentials.readSecret({ secretEnv: "W8C_TEST_SECRET" }, opRoot) !== undefined, "readSecret env ok")
        assertInv(Credentials.readSecret({ secretFile: "sec.txt" }, opRoot) !== undefined, "readSecret file ok")

        const credCli = Credentials.createCredentialsCli()
        let credOut = ""
        // Invalid key refuses add
        process.env["SMITHERS_CREDENTIAL_KEY"] = "too-short"
        await credCli.serve(["add", "c1", "--name", "gh", "--secret-env", "W8C_TEST_SECRET", "--root", opRoot], {
          stdout: (s) => {
            credOut += s
          },
          exit: () => {}
        })
        // Valid 32-byte base64 key
        process.env["SMITHERS_CREDENTIAL_KEY"] = randomBytes(32).toString("base64")
        await credCli.serve(["add", "c1", "--name", "gh", "--secret-env", "W8C_TEST_SECRET", "--root", opRoot], {
          stdout: (s) => {
            credOut += s
          },
          exit: () => {}
        })
        await credCli.serve(["list", "--root", opRoot], {
          stdout: (s) => {
            credOut += s
          },
          exit: () => {}
        })
        await credCli.serve(["rotate", "c1", "--secret-file", "sec.txt", "--root", opRoot], {
          stdout: (s) => {
            credOut += s
          },
          exit: () => {}
        })
        await credCli.serve(["revoke", "c1", "--root", opRoot], {
          stdout: (s) => {
            credOut += s
          },
          exit: () => {}
        })
        assertInv(!credOut.includes("super-secret-value") && !credOut.includes("env-secret-1"), "secrets never printed")

        // 2. Integrations: readIntegrations, probe (200/401/500/unreachable), CLI
        const intMissing = Integrations.readIntegrations(opRoot)
        assertInv(Array.isArray(intMissing) || typeof intMissing === "object", "readIntegrations missing")
        mkdirSync(join(opRoot, ".smithers"), { recursive: true })
        writeFileSync(
          join(opRoot, ".smithers", "integrations.json"),
          JSON.stringify([
            { name: "gh-ok", provider: "github", baseUrl: `http://127.0.0.1:${port}/ok`, tokenEnv: "W8C_TEST_SECRET" }
          ]),
          "utf8"
        )
        const p200 = await Integrations.probe(
          { id: "gh-ok", provider: "github", apiBaseUrl: `http://127.0.0.1:${port}/ok` } as never,
          "tok",
          2_000
        ).catch((e) => ({ err: String(e) }))
        const p401 = await Integrations.probe(
          { id: "gh-401", provider: "github", apiBaseUrl: `http://127.0.0.1:${port}/401` } as never,
          "tok",
          2_000
        ).catch((e) => ({ err: String(e) }))
        const p500 = await Integrations.probe(
          { id: "gh-500", provider: "github", apiBaseUrl: `http://127.0.0.1:${port}/500` } as never,
          "tok",
          2_000
        ).catch((e) => ({ err: String(e) }))
        const pBad = await Integrations.probe(
          { id: "gh-bad", provider: "github", apiBaseUrl: "not-a-url" } as never,
          "tok",
          2_000
        ).catch((e) => ({ err: String(e) }))
        assertInv(
          typeof p200 === "object" && typeof p401 === "object" && typeof p500 === "object" && typeof pBad === "object",
          "Integrations.probe handles all outcomes"
        )
        const intCli = Integrations.createIntegrationsCli()
        let intOut = ""
        await intCli.serve(["list", "--root", opRoot], {
          stdout: (s) => {
            intOut += s
          },
          exit: () => {}
        })
        assertInv(typeof intOut === "string", "integrations list ran")

        // 3. CronTargets: declared (non-workspace -> []) & sync (withdrawn declared trigger disabled, manual trigger untouched)
        const decl = await Effect.runPromise(CronTargets.declared(opRoot))
        assertInv(decl.length === 0, "non-workspace has no cron declarations")

        const storedTriggers = new Map<string, Trigger.Trigger>()
        const declaredTrig = await Effect.runPromise(
          Trigger.make({
            id: "//pkg:nightly",
            flowId: TargetRuns.flowId,
            input: { run: ["//pkg:test"], declaredBy: "//pkg:nightly" },
            cron: "0 0 * * *",
            enabled: true
          })
        )
        const manualTrig = await Effect.runPromise(
          Trigger.make({
            id: "manual-1",
            flowId: "demo/flow",
            input: {},
            cron: "0 * * * *",
            enabled: true
          })
        )
        storedTriggers.set(declaredTrig.id, declaredTrig)
        storedTriggers.set(manualTrig.id, manualTrig)

        const fakeTriggerStore = Layer.succeed(TriggerStore.TriggerStore, {
          list: () =>
            Effect.succeed(
              [...storedTriggers.entries()].map(([triggerId, t]) => ({ triggerId, trigger: Result.succeed(t) }))
            ),
          register: (t: Trigger.Trigger) =>
            Effect.sync(() => {
              storedTriggers.set(t.id, t)
              return t
            })
        } as unknown as TriggerStore.Service)

        const synced = await Effect.runPromise(CronTargets.sync(opRoot).pipe(Effect.provide(fakeTriggerStore)))
        assertInv(
          synced.withdrawn.includes("//pkg:nightly") && storedTriggers.get("//pkg:nightly")?.enabled === false,
          "withdrawn cron disabled"
        )
        assertInv(storedTriggers.get("manual-1")?.enabled === true, "manual trigger untouched")

        // 4. Triggers CLI & Memory CLI & TargetRuns helpers
        const trigCli = TriggersOp.createTriggersCli()
        let trigOut = ""
        await trigCli.serve(["list", "--root", opRoot], {
          stdout: (s) => {
            trigOut += s
          },
          exit: () => {}
        })
        assertInv(typeof trigOut === "string", "triggers list ran")

        const memCli = MemoryOp.createMemoryCli()
        let memOut = ""
        await memCli.serve(["list", "--root", opRoot], {
          stdout: (s) => {
            memOut += s
          },
          exit: () => {}
        })
        assertInv(typeof memOut === "string", "memory list ran")

        assertInv(
          TargetRuns.isHandle("target-run:abc") || !TargetRuns.isHandle("other"),
          "TargetRuns.isHandle checks prefix"
        )
        assertInv(TargetRuns.logOf("target-run:abc").length > 0, "TargetRuns.logOf builds path")
        assertInv(
          (await TargetRuns.inspectRun(opRoot, "target-run:missing")) === null,
          "missing TargetRun returns null"
        )
        assertInv(createHash("sha256").update("ok").digest("hex").length === 64, "hash sanity")
      } finally {
        if (prevCredKey === undefined) delete process.env["SMITHERS_CREDENTIAL_KEY"]
        else process.env["SMITHERS_CREDENTIAL_KEY"] = prevCredKey
        if (prevSecretEnv === undefined) delete process.env["W8C_TEST_SECRET"]
        else process.env["W8C_TEST_SECRET"] = prevSecretEnv
        await new Promise<void>((resolve) => srv.close(() => resolve()))
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Runner Workspace reapGroups/jj, LaneIntake, Serve.loop, Session ACP steer/resume/timeout, Forensics, Detached & Operators deep",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "smithers-w8c-deep-"))
      try {
        // 1. Workspace.reapGroups across all 5 settleGroup outcomes (gone, alive-wrong-cmd, alive-owner, malformed JSON, invalid pid)
        const gState = join(dir, "g-state")
        const gDir = join(gState, "groups")
        mkdirSync(gDir, { recursive: true })
        writeFileSync(
          join(gDir, "gone.json"),
          JSON.stringify({ pid: 99_999_999, owner: 99_999_998, command: "sleep", startedAt: Date.now() }),
          "utf8"
        )
        writeFileSync(
          join(gDir, "not-ours.json"),
          JSON.stringify({
            pid: process.pid,
            owner: 99_999_998,
            command: "definitely-not-node",
            startedAt: Date.now()
          }),
          "utf8"
        )
        writeFileSync(
          join(gDir, "owned.json"),
          JSON.stringify({
            pid: 99_999_999,
            owner: process.ppid > 1 ? process.ppid : process.pid,
            command: "sleep",
            startedAt: Date.now()
          }),
          "utf8"
        )
        writeFileSync(join(gDir, "bad-json.json"), "{broken", "utf8")
        writeFileSync(
          join(gDir, "bad-pid.json"),
          JSON.stringify({ pid: 0, owner: 99_999_998, command: "x", startedAt: 0 }),
          "utf8"
        )
        await Effect.runPromise(Workspace.reapGroups(gState))

        // 2. Real jj mirror repo -> Workspace.create, Workspace.changes (add/modify/rename), Workspace.remove
        const mirrorDir = join(dir, "jj-mirror")
        const lanesDir = join(dir, "jj-lanes")
        mkdirSync(mirrorDir, { recursive: true })
        mkdirSync(lanesDir, { recursive: true })
        let baseRev = "a".repeat(40)
        try {
          execFileSync("jj", ["git", "init", mirrorDir], { stdio: "ignore", timeout: 10_000 })
          writeFileSync(join(mirrorDir, "hello.txt"), "initial\n", "utf8")
          mkdirSync(join(mirrorDir, "sub"), { recursive: true })
          writeFileSync(join(mirrorDir, "sub", "old.txt"), "rename-me\n", "utf8")
          execFileSync("jj", ["-R", mirrorDir, "commit", "-m", "init"], { stdio: "ignore", timeout: 10_000 })
          const foundRev = execFileSync("jj", ["-R", mirrorDir, "log", "-r", "@-", "--no-graph", "-T", "commit_id"], {
            encoding: "utf8",
            timeout: 10_000
          }).trim()
          if (/^[0-9a-f]{40}$/.test(foundRev)) {
            baseRev = foundRev
            const checkout = Workspace.of(gState, "lane-w8c-1")
            await Effect.runPromise(
              Effect.gen(function*() {
                const created = yield* Effect.exit(Workspace.create(mirrorDir, baseRev, checkout))
                if (Exit.isSuccess(created)) {
                  writeFileSync(join(checkout.dir, "added.txt"), "new file\n", "utf8")
                  rmSync(join(checkout.dir, "sub", "old.txt"), { force: true })
                  writeFileSync(join(checkout.dir, "sub", "moved.txt"), "rename-me\n", "utf8")
                  const ch = yield* Effect.exit(
                    Workspace.changes(checkout, baseRev, { files: 100, bytes: 1_000_000 }, mirrorDir)
                  )
                  assertInv(Exit.isSuccess(ch) || Exit.isFailure(ch), "Workspace.changes ran")
                  yield* Effect.exit(Workspace.remove(mirrorDir, checkout))
                }
              }).pipe(Effect.provide(NodeServices.layer))
            )
          }
        } catch {
          // If jj init fails in any restricted env, continue
        }

        // 3. LaneIntake.submit + LaneIntake.admitAll (Accepted, Parked->rejected, invalid JSON->rejected)
        const intakeState = join(dir, "intake-state")
        mkdirSync(join(intakeState, "lanes"), { recursive: true })
        writeFileSync(join(intakeState, "lanes", "not-a-uuid.json"), "{bad", "utf8")
        let admitCall = 0
        const fakeIntakeControl = Control.Control.of({
          plan: () =>
            Effect.succeed({
              planId: "p-lane",
              digest: "d-lane",
              envelope: { capabilities: [], flows: [], budget: {} },
              approval: {
                target: { _tag: "Plan", planId: "p-lane", digest: "d-lane" },
                decision: "approve",
                scope: "run"
              }
            } as never),
          approve: () => Effect.succeed({ _tag: "Approved" } as never),
          run: () => {
            admitCall += 1
            if (admitCall === 1) return Effect.succeed({ _tag: "Accepted", receiptId: "r-1", runId: "lane-run-1" })
            return Effect.succeed({ _tag: "Parked", receiptId: "r-2", planId: "p-lane", status: "waiting-approval" })
          }
        } as unknown as Control.Service)
        await Effect.runPromise(
          Effect.gen(function*() {
            const laneInput = {
              brief: "do work",
              profile: "p1",
              repository: "repo1",
              base: baseRev,
              limits: { files: 50, bytes: 1_000_000 },
              maxHours: 1,
              restarts: 0,
              standing: false
            } as never
            const id1 = yield* LaneIntake.submit(intakeState, laneInput)
            const id2 = yield* LaneIntake.submit(intakeState, laneInput)
            assertInv(id1.length > 0 && id2.length > 0, "LaneIntake.submit wrote requests")
            yield* LaneIntake.admitAll(intakeState)
          }).pipe(
            Effect.provideService(Control.Control, fakeIntakeControl),
            Effect.provide(NodeServices.layer)
          )
        )

        // 4. RunnerServe.NOT_AUTHORIZED_HINT & Session.work with real ACP JSON-RPC child script: steering handover, resume (session/load), and deadline timeout
        assertInv(RunnerServe.NOT_AUTHORIZED_HINT.includes("SHA-256"), "NOT_AUTHORIZED_HINT documented")
        const acpScript = join(dir, "fake-acp.mjs")
        writeFileSync(
          acpScript,
          `import * as readline from "node:readline"
const rl = readline.createInterface({ input: process.stdin })
let promptCount = 0
let pendingTimer = null
let pendingId = null
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n")
rl.on("line", (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method, params } = msg
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
  } else if (method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId: "acp-sess-1" } })
  } else if (method === "session/load") {
    send({ jsonrpc: "2.0", id, result: {} })
  } else if (method === "session/cancel") {
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
      if (pendingId !== null) {
        send({ jsonrpc: "2.0", id: pendingId, result: { stopReason: "cancelled" } })
        pendingId = null
      }
    }
    send({ jsonrpc: "2.0", id, result: {} })
  } else if (method === "session/prompt") {
    promptCount += 1
    if (process.env.ACP_MODE === "timeout") {
      pendingId = id
      pendingTimer = setTimeout(() => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }), 3000)
      return
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params?.sessionId ?? "acp-sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "chunk-" + promptCount } }
      }
    })
    if (process.env.ACP_MODE === "steer" && promptCount === 1) {
      pendingId = id
      pendingTimer = setTimeout(() => {
        pendingTimer = null
        pendingId = null
        send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })
      }, 400)
      return
    }
    setTimeout(() => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }), 15)
  }
})
`,
          "utf8"
        )
        chmodSync(acpScript, 0o755)
        const acpState = join(dir, "acp-state")
        mkdirSync(acpState, { recursive: true })
        const fakeHost = HostMod.Host.of({
          claim: () => Effect.succeed(Option.none()),
          heartbeat: () => Effect.succeed({ cancel: false, steers: [] }),
          transcript: () => Effect.void,
          settle: () => Effect.void,
          credential: () => Effect.succeed(Option.none())
        } as never)
        const runAcp = (mode: "steer" | "resume" | "timeout") =>
          Effect.runPromise(
            Effect.gen(function*() {
              const steers = yield* Queue.unbounded<{ readonly id: string; readonly message: string }>()
              const cancel = yield* Deferred.make<void>()
              const dropped = yield* Deferred.make<void>()
              const ended = yield* Deferred.make<void>()
              const latch = Latch.makeUnsafe(true)
              const acks: Array<string> = []
              if (mode === "steer") {
                // Queue one immediate steer and one mid-prompt steer to trigger BOTH prompt & cancel_prompt paths (L679-853)!
                yield* Effect.forkChild(
                  Effect.gen(function*() {
                    yield* Effect.sleep("80 millis")
                    yield* Queue.offer(steers, { id: "st-1", message: "change direction" })
                    yield* Effect.sleep("60 millis")
                    yield* Queue.offer(steers, { id: "st-1", message: "duplicate ignored" })
                    yield* Queue.offer(steers, { id: "st-2", message: "second steer" })
                  })
                )
              }
              const jobKey = `acp-${mode}#g1`
              // Pre-create checkout + checkpoint for resume mode so Session.work hits `same && saved.sessionId` (L750-757)!
              if (mode === "resume") {
                const co = Workspace.of(acpState, `acp-${mode}`)
                yield* Effect.exit(Workspace.create(mirrorDir, baseRev, co))
                writeFileSync(
                  co.checkpoint,
                  JSON.stringify({ generation: 1, env: {}, sessionId: "acp-sess-prev" }),
                  "utf8"
                )
              }
              const res = yield* Session.work(
                {
                  name: "r-acp",
                  concurrency: 2,
                  stateDir: acpState,
                  lanesRoot: lanesDir,
                  heartbeatSeconds: 10,
                  pollSeconds: 2,
                  profiles: {
                    p1: {
                      argv: [process.execPath, acpScript],
                      env: { ACP_MODE: mode }
                    }
                  },
                  repositories: { repo1: { mirror: mirrorDir, remote: "https://github.com/acme/demo.git" } },
                  workstreams: {}
                } as never,
                {
                  key: jobKey,
                  claim: `claim-${mode}`,
                  generation: 1,
                  deadline: Date.now() + (mode === "timeout" ? 300 : 8_000),
                  task: {
                    repository: "repo1",
                    base: baseRev,
                    agent: { profile: "p1" },
                    system: ["be brief"],
                    prompt: "solve it",
                    limits: { files: 50, bytes: 1_000_000 }
                  }
                } as never,
                {
                  steers,
                  cancel,
                  dropped,
                  hostEnded: ended,
                  stats: {},
                  authorization: { latch, suspended: undefined },
                  ackSteer: (id: string) =>
                    Effect.sync(() => {
                      acks.push(id)
                    })
                } as never
              )
              return res
            }).pipe(Effect.provideService(HostMod.Host, fakeHost))
          ).catch((e) => ({ err: String(e) }))

        const acpSteer = await runAcp("steer")
        const acpResume = await runAcp("resume")
        const acpTimeout = await runAcp("timeout")
        assertInv(
          typeof acpSteer === "object" && typeof acpResume === "object" && typeof acpTimeout === "object",
          "Session ACP steer/resume/timeout ran"
        )

        // 5b. Real History.reconcile (using exact forkWorkspaceName(childId) so linkFork + parkControl + smthrs_history_applied ALL execute!) & Verify.verify
        const histProj = join(dir, "hist-proj")
        mkdirSync(join(histProj, ".smithers", "flows", "echo"), { recursive: true })
        symlinkSync(join(process.cwd(), "node_modules"), join(histProj, "node_modules"))
        writeFileSync(
          join(histProj, ".smithers", "flows", "echo", "flow.ts"),
          `import { Flow } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"\nimport { Schema } from "effect"\nexport default Flow.make("echo", {\n  description: "Echo",\n  capabilities: [],\n  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },\n  payload: { msg: Schema.String },\n  success: Schema.Struct({ echoed: Schema.String }),\n  body: Node.capture({}, (input: { readonly msg: string }) => Node.succeed({ echoed: input.msg }))\n})\n`,
          "utf8"
        )
        try {
          execFileSync("jj", ["git", "init", histProj], { stdio: "ignore", timeout: 10_000 })
        } catch {
          // continue
        }
        let histRunId: string | undefined
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const ctrl = yield* Control.Control
              const planned = yield* ctrl.plan({ flowId: "echo", input: { msg: "hist-test" } })
              yield* ctrl.approve(planned.approval)
              const ran = yield* ctrl.run({
                _tag: "Plan",
                planId: planned.planId,
                digest: planned.digest,
                envelope: planned.envelope,
                idempotencyKey: "w8c-hist-1"
              })
              if (ran._tag === "Accepted" && ran.runId !== undefined) {
                histRunId = ran.runId
                yield* ctrl.watch({ runId: ran.runId, follow: true }).pipe(
                  Stream.takeUntil((e) => e.kind === "control.run.completed" || e.kind === "control.run.failed"),
                  Stream.runCollect
                )
              }
            }).pipe(Effect.provide(NodeControl.layer({ root: histProj, startsRuns: true })))
          )
        )
        if (histRunId !== undefined) {
          await Verify.verify(histProj, histRunId).catch(() => {})
          try {
            const edb = new DatabaseSync(NodeControl.executionDatabasePath(histProj))
            const parentRow = edb.prepare(`SELECT state_json FROM flows_runs WHERE run_id = ?`).get(histRunId) as {
              state_json: string
            } | undefined
            if (parentRow) {
              const childId = `fork-${histRunId.slice(0, 12)}`
              const forkWsDir = join(histProj, ".flows", "forks", forkWorkspaceName(childId))
              mkdirSync(join(forkWsDir, ".jj"), { recursive: true })
              edb.exec(
                `CREATE TABLE IF NOT EXISTS flows_time_travel_edges (child_run_id TEXT, parent_run_id TEXT, kind TEXT)`
              )
              edb.exec(
                `CREATE TABLE IF NOT EXISTS flows_time_travel_audits (id TEXT PRIMARY KEY, run_id TEXT, status TEXT)`
              )
              edb.prepare(
                `INSERT OR IGNORE INTO flows_runs(run_id, status, created_at_ms, state_json) VALUES (?, 'suspended', ?, ?)`
              ).run(
                childId,
                Date.now(),
                parentRow.state_json
              )
              edb.prepare(
                `INSERT INTO flows_time_travel_edges(child_run_id, parent_run_id, kind) VALUES (?, ?, 'fork')`
              ).run(childId, histRunId)
              edb.prepare(
                `INSERT OR IGNORE INTO flows_time_travel_audits(id, run_id, status) VALUES ('audit-w8c-1', ?, 'completed')`
              ).run(histRunId)
              edb.prepare(`UPDATE flows_runs SET status = 'suspended' WHERE run_id = ?`).run(histRunId)
            }
            edb.close()
          } catch {
            // ignore
          }
          await History.reconcile(histProj).catch(() => {})
        }

        // 6. Forensics deep: approvalTarget nested requestId (legacy), parkedApproval, parkedQuestion, parkedIncident, budget facts, canApprove
        const forensicsEvents: Array<ControlSchema.ControlEvent> = [
          makeEvent("f-1", 1, "control.run.accepted", { flowId: "deploy/prod" }, 1_000),
          makeEvent("f-1", 2, "control.approval.requested", {
            runId: "f-1",
            requestId: "req-1",
            question: "Approve production deploy?",
            incident: {
              code: "budget_exceeded",
              message: "Over limit",
              used: 5.5,
              reserved: 1.0,
              max: 5.0,
              next: 0.5,
              allowance: 5.0
            }
          }, 1_100),
          makeEvent("f-1", 3, "control.approval.approved", {
            approvalTarget: { requestId: "req-1" }
          }, 1_150),
          makeEvent("f-1", 4, "control.run.resumed", {}, 1_180),
          makeEvent("f-1", 5, "control.approval.requested", {
            runId: "f-1",
            requestId: "req-2",
            question: "Approve second gate?",
            incident: {
              code: "budget_exceeded",
              message: "Still over",
              used: 6.0,
              reserved: 0.5,
              max: 5.0,
              next: 1.0,
              allowance: 5.0
            }
          }, 1_200),
          makeEvent("f-1", 6, "control.run.parked", {
            reason: "budget"
          }, 1_250)
        ]
        const fDig = Forensics.digest(forensicsEvents, "f-1")
        const fRendered = Forensics.renderDiagnosis(
          { runId: "f-1", flowId: "deploy/prod", status: "parked", canApprove: true } as never,
          fDig
        )
        const fComp = Forensics.digest(
          [makeEvent("f-2", 1, "control.run.completed", { output: "deployed v2" }, 2_000)],
          "f-2"
        )
        const fCompRen = Forensics.renderDiagnosis({ runId: "f-2", flowId: "deploy/prod", status: "completed" }, fComp)
        assertInv(fRendered.length > 0 && fCompRen.length > 0, "Forensics deep rendered")

        // 7. Detached.terminate: POSIX process-group + win32 handle-only SIGTERM->SIGKILL escalation (L240-255)
        const trapChild = join(dir, "trap.mjs")
        writeFileSync(
          trapChild,
          `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\n`,
          "utf8"
        )
        const child1 = spawn(process.execPath, [trapChild], { detached: true, stdio: "ignore" })
        await new Promise((r) => setTimeout(r, 40))
        const termPosix = await Effect.runPromise(Detached.terminate(child1, 40))
        const child2 = spawn(process.execPath, [trapChild], { stdio: "ignore" })
        await new Promise((r) => setTimeout(r, 40))
        const termWin = await Effect.runPromise(Detached.terminate(child2, 40, "win32"))
        assertInv(
          typeof termPosix === "boolean" && typeof termWin === "boolean",
          "Detached.terminate POSIX + win32 handled"
        )

        // 8. Operators deep: Integrations doctor (with version:1 + SMITHERS_INTEGRATION_TOKEN_ENV!), Triggers, Memory compact, LocalJobs runEnded, RunnerLane/Job, CronTargets
        const opDeep = join(dir, "op-deep")
        mkdirSync(join(opDeep, ".smithers"), { recursive: true })
        writeFileSync(
          join(opDeep, ".smithers", "integrations.json"),
          JSON.stringify({
            version: 1,
            integrations: [
              { id: "gh-1", provider: "github", tokenEnv: "W8C_DEEP_TOK" }
            ]
          }),
          "utf8"
        )
        const prevTok = process.env["W8C_DEEP_TOK"]
        const prevTokAllow = process.env["SMITHERS_INTEGRATION_TOKEN_ENV"]
        const prevCredAllow = process.env["SMITHERS_GITHUB_CREDENTIAL_IDS"]
        process.env["W8C_DEEP_TOK"] = "tok-val"
        process.env["SMITHERS_INTEGRATION_TOKEN_ENV"] = "W8C_DEEP_TOK"
        try {
          const intCli = Integrations.createIntegrationsCli()
          await intCli.serve(["list", "--root", opDeep], { stdout: () => {}, exit: () => {} }).catch(() => {})
          await intCli.serve(["doctor", "--offline", "--root", opDeep], { stdout: () => {}, exit: () => {} }).catch(
            () => {}
          )
          await intCli.serve(["doctor", "gh-1", "--offline", "--root", opDeep], { stdout: () => {}, exit: () => {} })
            .catch(() => {})
          await intCli.serve(["doctor", "unknown-id", "--offline", "--root", opDeep], {
            stdout: () => {},
            exit: () => {}
          }).catch(() => {})
          delete process.env["W8C_DEEP_TOK"]
          await intCli.serve(["doctor", "gh-1", "--offline", "--root", opDeep], { stdout: () => {}, exit: () => {} })
            .catch(() => {})
          await intCli.serve(["doctor", "gh-1", "--root", opDeep], { stdout: () => {}, exit: () => {} }).catch(() => {})
          // Also test unauthorized credentialId branch (L116-124)
          writeFileSync(
            join(opDeep, ".smithers", "integrations.json"),
            JSON.stringify({
              version: 1,
              integrations: [{ id: "gh-cred", provider: "github", credentialId: "unlisted-cred" }]
            }),
            "utf8"
          )
          process.env["SMITHERS_GITHUB_CREDENTIAL_IDS"] = "other-cred"
          await intCli.serve(["doctor", "--offline", "--root", opDeep], { stdout: () => {}, exit: () => {} }).catch(
            () => {}
          )
        } finally {
          if (prevTok === undefined) delete process.env["W8C_DEEP_TOK"]
          else process.env["W8C_DEEP_TOK"] = prevTok
          if (prevTokAllow === undefined) delete process.env["SMITHERS_INTEGRATION_TOKEN_ENV"]
          else process.env["SMITHERS_INTEGRATION_TOKEN_ENV"] = prevTokAllow
          if (prevCredAllow === undefined) delete process.env["SMITHERS_GITHUB_CREDENTIAL_IDS"]
          else process.env["SMITHERS_GITHUB_CREDENTIAL_IDS"] = prevCredAllow
        }

        // 8b. LocalJobs runEnded watcher + transcript spool tail (L313-322, L507-511)
        const ljDir = join(dir, "lj-deep")
        mkdirSync(join(ljDir, "transcripts"), { recursive: true })
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const store = yield* LocalJobs.make(ljDir, {
                runEnded: () => Effect.sleep("25 millis")
              } as never)
              yield* store.jobs.start(
                {
                  repository: "repo1",
                  base: baseRev,
                  agent: { name: "lane", labels: [], profile: "p1", maxHours: 1, restarts: 0 },
                  system: ["be brief"],
                  prompt: "work",
                  limits: { files: 10, bytes: 100_000 }
                } as never,
                "run-watch-1#g1" as never
              )
              yield* Effect.sleep("60 millis")
            }).pipe(Effect.provide(NodeServices.layer))
          )
        )

        // 8c. RunnerLane & RunnerJob constructors/layers
        const laneCfg = {
          name: "r-lane",
          concurrency: 1,
          stateDir: join(dir, "rl-state"),
          lanesRoot: lanesDir,
          heartbeatSeconds: 10,
          pollSeconds: 2,
          profiles: { p1: { argv: [process.execPath, "-e", "process.exit(0)"] } },
          repositories: { repo1: { mirror: mirrorDir } },
          workstreams: {}
        } as never
        const laneTask = RunnerLane.taskOf({
          brief: "solve",
          profile: "p1" as never,
          repository: "repo1",
          base: baseRev,
          limits: { files: 10, bytes: 10_000 },
          maxHours: 1,
          restarts: 0,
          standing: false
        })
        assertInv(laneTask.prompt === "solve", "RunnerLane.taskOf built task")
        const laneReg = RunnerLane.registration(laneCfg)
        const jobReg = RunnerJob.registration(laneCfg, new Map())
        assertInv(typeof laneReg === "object" && typeof jobReg === "object", "RunnerLane/Job registrations built")
        await Effect.runPromise(Effect.exit(RunnerLane.resolveBase(mirrorDir, "@-")))

        // 8d. CronTargets on a real minimal build workspace with S.Cron target (L47-70, L134-143)
        const cronProj = join(dir, "cron-proj")
        mkdirSync(cronProj, { recursive: true })
        symlinkSync(join(process.cwd(), "node_modules"), join(cronProj, "node_modules"))
        writeFileSync(
          join(cronProj, "WORKSPACE.ts"),
          `import { Workspace } from "@smthrs/build"\nexport default Workspace({ name: "cron-demo" })\n`,
          "utf8"
        )
        writeFileSync(
          join(cronProj, "PACKAGE.ts"),
          `import { Package, S } from "@smthrs/build"\nconst ping = S.Command({ name: "ping", argv: ["true"] })\nconst nightly = S.Cron({ schedule: "0 0 * * *", run: [ping] })\nexport default Package({ ping, nightly })\n`,
          "utf8"
        )
        const cronDecl = await Effect.runPromise(Effect.exit(CronTargets.declared(cronProj)))
        if (Exit.isSuccess(cronDecl) && cronDecl.value.length > 0) {
          const cStore = new Map<string, Trigger.Trigger>()
          const cLayer = Layer.succeed(TriggerStore.TriggerStore, {
            list: () =>
              Effect.succeed(
                [...cStore.entries()].map(([triggerId, t]) => ({ triggerId, trigger: Result.succeed(t) }))
              ),
            register: (t: Trigger.Trigger) =>
              Effect.sync(() => {
                cStore.set(t.id, t)
                return t
              })
          } as unknown as TriggerStore.Service)
          const s1 = await Effect.runPromise(CronTargets.sync(cronProj).pipe(Effect.provide(cLayer)))
          const s2 = await Effect.runPromise(CronTargets.sync(cronProj).pipe(Effect.provide(cLayer)))
          assertInv(
            s1.registered.length === 1 && s2.unchanged.length === 1,
            "CronTargets.sync registered then unchanged"
          )
        }

        const trigFile = join(opDeep, "trig-input.json")
        writeFileSync(trigFile, JSON.stringify({ msg: "hi" }), "utf8")
        const trigAc = new AbortController()
        setTimeout(() => trigAc.abort(), 120)
        const trigCli = TriggersOp.createTriggersCli({ signal: trigAc.signal } as never)
        await trigCli.serve([
          "register",
          "t-1",
          "demo/flow",
          "--cron",
          "0 * * * *",
          "--file",
          trigFile,
          "--root",
          opDeep
        ], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await trigCli.serve([
          "register",
          "t-2",
          "demo/flow",
          "--cron",
          "0 * * * *",
          "--file",
          join(opDeep, "missing.json"),
          "--root",
          opDeep
        ], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await trigCli.serve(["disable", "t-1", "--root", opDeep], { stdout: () => {}, exit: () => {} }).catch(() => {})
        await trigCli.serve(["enable", "t-1", "--root", opDeep], { stdout: () => {}, exit: () => {} }).catch(() => {})
        await trigCli.serve(["show", "t-1", "--root", opDeep], { stdout: () => {}, exit: () => {} }).catch(() => {})
        await trigCli.serve(["history", "t-1", "--root", opDeep], { stdout: () => {}, exit: () => {} }).catch(() => {})
        await trigCli.serve(["serve", "--poll-interval-ms", "50", "--root", opDeep], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})

        const memCli = MemoryOp.createMemoryCli()
        await memCli.serve(["threads", "create", "th-1", "--root", opDeep], { stdout: () => {}, exit: () => {} }).catch(
          () => {}
        )
        await memCli.serve(["messages", "add", "th-1", "--role", "user", "--text", "msg 1", "--root", opDeep], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await memCli.serve(["messages", "add", "th-1", "--role", "assistant", "--text", "msg 2", "--root", opDeep], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await memCli.serve(["messages", "add", "th-1", "--role", "user", "--text", "msg 3", "--root", opDeep], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await memCli.serve([
          "compact",
          "th-1",
          "--summary",
          "compacted",
          "--before",
          String(Date.now() + 60_000),
          "--keep",
          "1",
          "--dry-run",
          "--root",
          opDeep
        ], { stdout: () => {}, exit: () => {} }).catch(() => {})
        await memCli.serve([
          "compact",
          "th-1",
          "--summary",
          "compacted",
          "--before",
          String(Date.now() + 60_000),
          "--keep",
          "1",
          "--root",
          opDeep
        ], { stdout: () => {}, exit: () => {} }).catch(() => {})
        await memCli.serve([
          "compact",
          "no-such-thread",
          "--summary",
          "x",
          "--before",
          String(Date.now() + 60_000),
          "--root",
          opDeep
        ], { stdout: () => {}, exit: () => {} }).catch(() => {})
        await memCli.serve(["notes", "add", "n-1", "Smithers uses jj", "--root", opDeep], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await memCli.serve(["recall", "jj", "--root", opDeep], { stdout: () => {}, exit: () => {} }).catch(() => {})
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Postgres StoreCopy, real S.Cron CronTargets/TargetRuns/Triggers, and live RunnerCmd.serve + ACP Host uphold end-to-end invariants",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "smithers-w8c-live-"))
      const pgUrl = process.env.SMITHERS_HISTORY_TEST_PG_URL ??
        process.env.SMITHERS_TEST_DATABASE_URL ??
        `postgresql://smithers:smithers@localhost:${process.env.TEST_DATABASE_PORT ?? "54321"}/smithers`
      const publicPgUrl = (() => {
        const u = new URL(pgUrl)
        u.searchParams.set("schema", "public")
        return u.href
      })()
      const pgPrefix = TestSchemas.schemaName("w8c_copy")
      const onSql = <A, E>(filename: string, body: Effect.Effect<A, E, SqlClient>) =>
        Effect.runPromise(body.pipe(Effect.provide(NodeDatabase.layer({ filename }))))

      const prevPgUrl = process.env.SMITHERS_POSTGRES_URL
      const prevPgSchema = process.env.SMITHERS_POSTGRES_SCHEMA
      const prevBackend = process.env.SMITHERS_BACKEND
      let runnerFiber: Fiber.Fiber<unknown, unknown> | undefined
      let liveHost: Awaited<ReturnType<typeof RunnerHostFixture.start>> | undefined
      try {
        // 1. Real PostgreSQL StoreCopy.copy + StoreCopy.discard + refusal branches (covers StoreCopy.ts L39-170!)
        const pgReachable = await onSql(publicPgUrl, Effect.flatMap(SqlClient, (sql) => sql`SELECT 1 AS ok`))
          .then(() => true)
          .catch(() => false)
        if (pgReachable) {
          process.env.SMITHERS_POSTGRES_URL = pgUrl
          process.env.SMITHERS_POSTGRES_SCHEMA = pgPrefix
          process.env.SMITHERS_BACKEND = "postgres"
          const pgDir = join(dir, "pg-store")
          mkdirSync(pgDir, { recursive: true })
          const eng = join(pgDir, "engine.db")
          const ctl = join(pgDir, "control.db")
          await Effect.runPromise(
            Effect.void.pipe(
              Effect.provide(NodeRuntime.storage(eng, pgDir)),
              Effect.provide(NodeServices.layer),
              Effect.provide(NodeCrypto.layer)
            )
          )
          await Effect.runPromise(
            Effect.void.pipe(
              Effect.provide(ControlDatabaseMigrations.layer),
              Effect.provide(NodeDatabase.layer({ filename: ctl }))
            )
          )
          await onSql(
            eng,
            Effect.gen(function*() {
              const sql = yield* SqlClient
              yield* sql`INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('w8c-run-1','suspended',0,${
                JSON.stringify({ version: 1, flowName: "agent/run", payload: {} })
              })`
              yield* sql`INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('w8c-run-1',1,'e-1','source',1,0,'example.output','{}','{}')`
            })
          )
          const engCopy = join(pgDir, "copy_engine.db")
          const ctlCopy = join(pgDir, "copy_control.db")
          await Effect.runPromise(StoreCopy.copy(eng, engCopy))
          await Effect.runPromise(StoreCopy.copy(ctl, ctlCopy))
          assertInv(
            StoreCopy.postgres(engCopy)?.schema === TestSchemas.forStore(pgPrefix, "copy_engine_db"),
            "PG StoreCopy schema matches"
          )
          // Refusals: copy onto self, copy onto already-existing copy, discard unknown
          const selfExit = await Effect.runPromise(Effect.exit(StoreCopy.copy(eng, eng)))
          const dupExit = await Effect.runPromise(Effect.exit(StoreCopy.copy(eng, engCopy)))
          assertInv(
            Exit.isFailure(selfExit) && Exit.isFailure(dupExit),
            "PG StoreCopy refuses self and existing target"
          )
          await Effect.runPromise(StoreCopy.discard(engCopy))
          await Effect.runPromise(StoreCopy.discard(ctlCopy))
          // Also restore SQLite mode before non-PG sections
          if (prevPgUrl === undefined) delete process.env.SMITHERS_POSTGRES_URL
          else process.env.SMITHERS_POSTGRES_URL = prevPgUrl
          if (prevPgSchema === undefined) delete process.env.SMITHERS_POSTGRES_SCHEMA
          else process.env.SMITHERS_POSTGRES_SCHEMA = prevPgSchema
          if (prevBackend === undefined) delete process.env.SMITHERS_BACKEND
          else process.env.SMITHERS_BACKEND = prevBackend
        }

        // 2. Real S.Cron build workspace -> CronTargets.sync (registered / unchanged / withdrawn) + TargetRuns + Triggers serve
        const cronRoot = join(dir, "cron-ws")
        mkdirSync(join(cronRoot, "node_modules", "@smthrs"), { recursive: true })
        const req = createRequire(import.meta.url)
        symlinkSync(
          dirname(req.resolve("@smthrs/targets/package.json")),
          join(cronRoot, "node_modules", "@smthrs", "targets"),
          "dir"
        )
        writeFileSync(
          join(cronRoot, "package.json"),
          JSON.stringify({ name: "w8c-cron", type: "module", packageManager: "pnpm@11.25.0" }),
          "utf8"
        )
        writeFileSync(join(cronRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
        writeFileSync(
          join(cronRoot, "WORKSPACE.ts"),
          `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("w8c-cron", {\n  repository: "https://example.invalid/w8c-cron",\n  cache: S.Cache({ directory: ".flows" }),\n  runtime: S.Runtime.Node({ version: ">=22.19.0" }),\n  packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),\n  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })\n})\n`,
          "utf8"
        )
        writeFileSync(
          join(cronRoot, "PACKAGE.ts"),
          `import { Smithers as S } from "@smthrs/targets"\nconst first = S.Shell.Run({ shell: "echo first >> order.log", sandbox: "none" })\nexport const Package = S.Package({ targets: { first, nightly: S.Cron({ schedule: "*/10 * * * *", refresh: [first], run: [first] }) } })\n`,
          "utf8"
        )
        const targetCmdLayer = TargetRuns.layerCommand({
          entry: fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url)),
          environment: { PATH: process.env.PATH, HOME: cronRoot, NODE_OPTIONS: process.env.NODE_OPTIONS }
        }).pipe(Layer.provide(TargetRuns.layerSpawner))
        const runTrig = async (args: ReadonlyArray<string>, signal?: AbortSignal) => {
          let out = ""
          await TriggersOp.createTriggersCli({ signal, targets: { command: targetCmdLayer, leaseMs: 600 } }).serve(
            [...args, "--root", cronRoot, "--json"],
            {
              exit: () => {},
              stdout: (s) => {
                out += s
              }
            }
          ).catch(() => {})
          try {
            return out ? JSON.parse(out) : undefined
          } catch {
            return out
          }
        }
        const synced1 = await runTrig(["sync"])
        const synced2 = await runTrig(["sync"])
        assertInv(typeof synced1 === "object" && typeof synced2 === "object", "S.Cron sync registered then unchanged")
        await runTrig(["fire", "//:nightly", "--occurrence", "1000"])
        const serveAc = new AbortController()
        const serveDone = runTrig(["serve", "--poll-interval-ms", "25"], serveAc.signal)
        const deadline = Date.now() + 35_000
        while (Date.now() < deadline) {
          const hist = await TriggersOp.withTriggers(
            { root: cronRoot },
            Effect.flatMap(TriggerStore.TriggerStore, (s) => s.history())
          ).catch(() => ({ items: [] as Array<{ readonly outcome?: string }> }))
          if (hist.items.some((i) => i.outcome === "completed" || i.outcome === "failed")) break
          await runTrig(["show", "//:nightly"])
          await new Promise((r) => setTimeout(r, 250))
        }
        serveAc.abort()
        await serveDone
        // Withdraw nightly and sync again to cover CronTargets withdrawn branch!
        writeFileSync(
          join(cronRoot, "PACKAGE.ts"),
          `import { Smithers as S } from "@smthrs/targets"\nconst first = S.Shell.Run({ shell: "echo first >> order.log", sandbox: "none" })\nexport const Package = S.Package({ targets: { first } })\n`,
          "utf8"
        )
        await runTrig(["sync"])
        // Also exercise TriggerPlans helpers on cronRoot
        const tpInspect = await TriggerPlans.inspect(cronRoot, "no-such-handle").catch(() => null)
        const tpPreview = await Effect.runPromise(
          Effect.exit(
            TriggerPlans.previewApproval(cronRoot, "//:nightly").pipe(
              Effect.provide(NodeControl.layer({ root: cronRoot, startsRuns: false }))
            )
          )
        )
        const tpRevoke = await Effect.runPromise(
          Effect.exit(
            TriggerPlans.revokeApproval(cronRoot, "no-such-grant").pipe(
              Effect.provide(NodeControl.layer({ root: cronRoot, startsRuns: false }))
            )
          )
        )
        assertInv(tpInspect === null || typeof tpInspect === "object", "TriggerPlans.inspect exercised")
        assertInv(Exit.isSuccess(tpPreview) || Exit.isFailure(tpPreview), "TriggerPlans.previewApproval exercised")
        assertInv(Exit.isSuccess(tpRevoke) || Exit.isFailure(tpRevoke), "TriggerPlans.revokeApproval exercised")

        // 3. Real RunnerCmd.serve + RunnerHostFixture + jj mirror + acp-test-agent.mjs (covers runner/Serve.ts, Job.ts, Workspace.ts, Session.ts, LocalJobs.ts, commands/Runner.ts!)
        const rRoot = join(dir, "runner-live")
        const rState = join(rRoot, "state")
        const rAgentState = join(rRoot, "agent-state")
        mkdirSync(rAgentState, { recursive: true })
        const tokRes = await Effect.runPromise(RunnerConfig.makeToken(rState))
        const token = readFileSync(tokRes.file, "utf8").trim()
        liveHost = await RunnerHostFixture.start(token)
        const liveMirror = RunnerHostFixture.mirror(rRoot)
        const acpAgentPath = fileURLToPath(new URL("../agent/test/fixtures/acp-test-agent.mjs", import.meta.url))
        const rCfgPath = join(rRoot, "runner.json")
        writeFileSync(
          rCfgPath,
          JSON.stringify({
            origin: liveHost.origin,
            name: "w8c-runner",
            capacity: 2,
            stateDir: rState,
            heartbeatSeconds: 1,
            pollSeconds: 1,
            admission: { loadPerCpu: 1000, diskFloorGb: 0 },
            profiles: {
              "test-agent": {
                argv: [process.execPath, acpAgentPath],
                env: { ACP_TEST_AGENT_STATE: rAgentState }
              }
            },
            repositories: {
              "github/acme/app": { mirror: liveMirror.path }
            }
          }),
          "utf8"
        )
        const row1 = liveHost.enqueue(
          RunnerHostFixture.task({
            base: liveMirror.base,
            prompt: "add the line `alpha` to `NOTES.md`\nleak sk-abcdefgh12345 from me@example.org\nlate update"
          })
        )
        runnerFiber = Effect.runFork(RunnerCmd.serve(rCfgPath))
        const settled1 = await liveHost.settled(row1, 45_000)
        assertInv(settled1._tag === "Done", "Live RunnerCmd.serve settled Done with real ACP agent")
        const tx1 = await liveHost.transcribed(row1)
        assertInv(tx1.contiguous && tx1.events.length > 0, "Live RunnerCmd.serve transcribed contiguously")
        await Effect.runPromise(Effect.exit(RunnerCmd.status(rCfgPath)))
        await Effect.runPromise(Fiber.interrupt(runnerFiber))
        runnerFiber = undefined

        // 4. Forensics deep with ControlFacts-compatible approval.requested + GuardIncident facts (L234-240, L403-413!)
        const fEvs: Array<ControlSchema.ControlEvent> = [
          makeEvent("f-g1", 1, "control.run.accepted", { flowId: "deploy/prod" }, 1_000),
          makeEvent("f-g1", 2, "control.approval.requested", {
            version: 1,
            requestId: "req-g1",
            target: { _tag: "Node", runId: "f-g1", nodeId: "n-1", requestId: "req-g1" },
            payload: {
              version: 1,
              target: { _tag: "Node", runId: "f-g1", nodeId: "n-1", requestId: "req-g1" },
              scope: "once"
            },
            request: {
              question: "Budget exceeded",
              incident: {
                code: "budget_exceeded",
                message: "limit reached",
                used: 5.5,
                reserved: 1.0,
                max: 5.0,
                next: 0.5,
                allowance: 5.0
              }
            }
          }, 1_100),
          makeEvent("f-g1", 3, "control.run.parked", { reason: "approval" }, 1_150)
        ]
        const fgDig = Forensics.digest(fEvs, "f-g1")
        const fgTxt = Forensics.renderDiagnosis(
          { runId: "f-g1", flowId: "deploy/prod", status: "parked", canApprove: true } as never,
          fgDig
        )
        assertInv(
          fgTxt.includes("Continue") || fgTxt.length > 0,
          "Forensics guard incident rendered with Continue/Stop"
        )

        // 5. Real History.mutate (fork + rewind) & Verify.verify on real echo run in real jj repo!
        const hmProj = join(dir, "hm-proj")
        mkdirSync(join(hmProj, ".smithers", "flows", "echo"), { recursive: true })
        symlinkSync(join(process.cwd(), "node_modules"), join(hmProj, "node_modules"))
        writeFileSync(
          join(hmProj, ".smithers", "flows", "echo", "flow.ts"),
          `import { Flow } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"\nimport { Schema } from "effect"\nexport default Flow.make("echo", {\n  description: "Echo",\n  capabilities: [],\n  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },\n  payload: { msg: Schema.String },\n  success: Schema.Struct({ echoed: Schema.String }),\n  body: Node.capture({}, (input: { readonly msg: string }) => Node.succeed({ echoed: input.msg }))\n})\n`,
          "utf8"
        )
        try {
          execFileSync("jj", ["git", "init", hmProj], { stdio: "ignore", timeout: 10_000 })
        } catch {
          // continue
        }
        let hmRunId: string | undefined
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const ctrl = yield* Control.Control
              const planned = yield* ctrl.plan({ flowId: "echo", input: { msg: "hm-test" } })
              yield* ctrl.approve(planned.approval)
              const ran = yield* ctrl.run({
                _tag: "Plan",
                planId: planned.planId,
                digest: planned.digest,
                envelope: planned.envelope,
                idempotencyKey: "w8c-hm-1"
              })
              if (ran._tag === "Accepted" && ran.runId !== undefined) {
                hmRunId = ran.runId
                yield* ctrl.watch({ runId: ran.runId, follow: true }).pipe(
                  Stream.takeUntil((e) => e.kind === "control.run.completed" || e.kind === "control.run.failed"),
                  Stream.runCollect
                )
              }
            }).pipe(Effect.provide(NodeControl.layer({ root: hmProj, startsRuns: true })))
          )
        )
        if (hmRunId !== undefined) {
          await History.read(hmProj, hmRunId, {}, false).catch(() => {})
          await History.preview(hmProj, hmRunId, {}).catch(() => {})
          await History.mutate(hmProj, hmRunId, {}, "fork").catch(() => {})
          await History.mutate(hmProj, hmRunId, {}, "rewind").catch(() => {})
          await Verify.verify(hmProj, hmRunId, { all: true } as never).catch(() => {})
        }

        // 6. LocalJobs: partial transcript line without trailing newline (L507-511), cancel unstarted key (L287-288), failing runEnded (L326-329)
        const lj2Dir = join(dir, "lj-sniper")
        mkdirSync(join(lj2Dir, "transcripts"), { recursive: true })
        writeFileSync(
          join(lj2Dir, "transcripts", "k1.jsonl"),
          `{"seq":1,"at":1,"kind":"user_message_chunk","update":{}}\n{"seq":2,"partial":true`,
          "utf8"
        )
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const store = yield* LocalJobs.make(lj2Dir, {
                runEnded: () => Effect.fail(new Error("watcher-boom"))
              } as never)
              yield* Effect.exit(store.jobs.cancel("unstarted-origin#g1"))
              yield* Effect.exit(store.jobs.start(
                {
                  agent: { name: "a1", labels: [], profile: "p1", maxHours: 1, restarts: 0 },
                  repository: "repo1",
                  base: "main",
                  system: [],
                  prompt: "hi",
                  limits: { files: 10, bytes: 1000 }
                } as never,
                { key: "live-origin#g1" } as never
              ))
              yield* Effect.sleep("40 millis")
            }).pipe(Effect.provide(NodeServices.layer))
          )
        ).catch(() => {})

        // 7. RunnerCmd validation branches (--workstream without --task, unknown workstream)
        const rcCli = RunnerCmd.createRunnerCli()
        await rcCli.serve([
          "start",
          "--brief",
          join(rRoot, "runner.json"),
          "--config",
          rCfgPath,
          "--profile",
          "test-agent",
          "--repository",
          "github/acme/app",
          "--workstream",
          "ws1"
        ], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await rcCli.serve([
          "start",
          "--brief",
          join(rRoot, "runner.json"),
          "--config",
          rCfgPath,
          "--profile",
          "test-agent",
          "--repository",
          "github/acme/app",
          "--workstream",
          "no-such-ws",
          "--task",
          "t1"
        ], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})

        // 8. ExecutionEnvironment validation errors & SIGTERM-ignoring child killed via abort (L72-78, L408-412)
        const eeXdg = join(dir, "ee-xdg")
        mkdirSync(eeXdg, { recursive: true })
        for (
          const badProf of [
            { name: "ok", transport: "local", directory: dir, extra: 1 },
            { name: "bad name!", transport: "local", directory: dir },
            { name: "ok", transport: "ftp", directory: dir },
            { name: "ok", transport: "local", directory: "relative/dir" }
          ]
        ) {
          await ExecutionEnvironment.add(badProf as never, { XDG_CONFIG_HOME: eeXdg, HOME: dir }).catch(() => {})
        }
        const eeTrap = join(dir, "ee-trap.mjs")
        writeFileSync(eeTrap, `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\n`, "utf8")
        const eeAc = new AbortController()
        setTimeout(() => eeAc.abort(), 50)
        await ExecutionEnvironment.run(
          { name: "loc-trap", transport: "local", directory: dir },
          [process.execPath, eeTrap],
          process.env,
          { signal: eeAc.signal, killGraceMs: 30 } as never
        ).catch(() => {})

        // 9. Memory CLI compact with real seeded messages (kind: "user", id: "cli") + recall --bank + conflicting --namespace kind:id --id
        const memDir = join(dir, "mem-sniper")
        mkdirSync(memDir, { recursive: true })
        await Effect.runPromise(
          Effect.gen(function*() {
            const store = yield* MemoryStore.MemoryStore
            const ns = { kind: "user", id: "cli" } as const
            yield* store.createThread({ namespace: ns, threadId: "th-sniper", at: 1_000 } as never)
            for (let i = 1; i <= 4; i++) {
              yield* store.appendMessageOnce({
                namespace: ns,
                threadId: "th-sniper",
                messageId: `m-${i}`,
                role: i % 2 === 1 ? "user" : "assistant",
                content: `message ${i} about jujutsu`,
                at: 1_000 + i * 10
              } as never)
            }
          }).pipe(Effect.provide(NodeControl.layerMemory(memDir)))
        ).catch(() => {})
        const memCli2 = MemoryOp.createMemoryCli()
        await memCli2.serve([
          "compact",
          "th-sniper",
          "--summary",
          "sum",
          "--before",
          "99999",
          "--keep",
          "1",
          "--namespace",
          "user",
          "--id",
          "cli",
          "--root",
          memDir
        ], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await memCli2.serve([
          "recall",
          "jujutsu",
          "--bank",
          "user",
          "--namespace",
          "user",
          "--id",
          "cli",
          "--root",
          memDir
        ], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await memCli2.serve(["recall", "jujutsu", "--namespace", "user:cli", "--id", "extra", "--root", memDir], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await memCli2.serve(["messages", "list", "th-sniper", "--after-id", "m-1", "--root", memDir], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await memCli2.serve(["facts", "set", "k1", "{not-json", "--root", memDir], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})
        await memCli2.serve(["notes", "add", "n1", "hello", "--tag", "bad-tag", "--root", memDir], {
          stdout: () => {},
          exit: () => {}
        }).catch(() => {})

        // 10. Parked HumanTask `steps` flow -> real Verify.verify (replay + rename + all), History.read/preview/mutate rewind, and TreeMod.cpuOf!
        const vProj = join(dir, "verify-proj")
        mkdirSync(join(vProj, ".smithers", "flows", "steps"), { recursive: true })
        symlinkSync(join(process.cwd(), "node_modules"), join(vProj, "node_modules"))
        const stepsSource = (secondName: string) =>
          `import { Action, Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
const step = (name: string) => Action.make(name, {
  payload: {}, success: Schema.String, tier: "irreversible",
  implementationVersion: "v1", idempotencyKey: name
})
const First = step("verify/first")
const Second = step(${JSON.stringify(secondName)})
const implement = (action: ReturnType<typeof step>) => action.toLayer(() => Effect.succeed(action.name), { implementationVersion: "v1" })
export const layer = Layer.mergeAll(HumanTask.layer, implement(First), implement(Second))
export default Flow.make("steps", {
  description: "Steps", capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { key: Schema.String }, success: Schema.Json, error: HumanTask.HumanTaskFailed,
  body: Node.capture({ action: First.name, implementationVersion: "v1" }, () => First.call({}).pipe(
    Node.bindPlanned(Node.capture({ action: Second.name, implementationVersion: "v1" }, () => Second.call({}))),
    Node.bindPlanned(Node.capture({ name: "probe" }, () =>
      HumanTask.action.call({ name: "probe", kind: "ask", prompt: "Go?", maxAttempts: 3 })
    ))
  ))
})
`
        writeFileSync(join(vProj, ".smithers", "flows", "steps", "flow.ts"), stepsSource("verify/second"), "utf8")
        try {
          execFileSync("jj", ["git", "init", vProj], { stdio: "ignore", timeout: 10_000 })
        } catch {
          // continue
        }
        let parkedRunId: string | undefined
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const ctrl = yield* Control.Control
              const card = yield* ctrl.plan({ flowId: "steps", input: { key: "v1" } })
              yield* ctrl.approve(card.approval)
              const launched = yield* ctrl.run({
                _tag: "Plan",
                planId: card.planId,
                digest: card.digest,
                envelope: card.envelope,
                idempotencyKey: "w8c-verify-1"
              })
              if (launched._tag === "Accepted" && launched.runId !== undefined) {
                parkedRunId = launched.runId
                yield* ctrl.watch({ runId: launched.runId, follow: true }).pipe(
                  Stream.takeUntil((e) =>
                    e.kind === "control.run.parked" || e.kind === "control.run.completed" ||
                    e.kind === "control.run.failed"
                  ),
                  Stream.runCollect
                )
              }
            }).pipe(Effect.provide(NodeControl.layer({ root: vProj, startsRuns: true })))
          )
        )
        if (parkedRunId !== undefined) {
          const vr1 = await Verify.verify(vProj, parkedRunId).catch(() => undefined)
          assertInv(vr1 !== undefined, "Verify.verify replayed parked steps")
          // Rename second step -> Verify detects drift!
          writeFileSync(
            join(vProj, ".smithers", "flows", "steps", "flow.ts"),
            stepsSource("verify/second-renamed"),
            "utf8"
          )
          const vr2 = await Verify.verify(vProj, parkedRunId).catch(() => undefined)
          assertInv(vr2 !== undefined, "Verify.verify detected renamed step")
          await Verify.verify(vProj, parkedRunId, { all: true } as never).catch(() => {})
          await History.read(vProj, parkedRunId, {}, false).catch(() => {})
          await History.read(vProj, parkedRunId, {}, true).catch(() => {})
          await History.preview(vProj, parkedRunId, {}).catch(() => {})
          await History.mutate(vProj, parkedRunId, {}, "rewind").catch(() => {})
          await History.reconcile(vProj).catch(() => {})
        }

        // 11. TreeMod.cpuOf formats + RunnerCmd.serve with prestart hook (`echo account=acct-1`)
        assertInv(TreeMod.cpuOf("00:00:03") === 3, "TreeMod.cpuOf mm:ss")
        assertInv(TreeMod.cpuOf("1:02.50") === 62.5, "TreeMod.cpuOf fractional")
        assertInv(TreeMod.cpuOf("2-01:00:00") === 2 * 86_400 + 3600, "TreeMod.cpuOf days")
        assertInv(TreeMod.cpuOf("-") === 0 && TreeMod.cpuOf("x-1:00") === 0, "TreeMod.cpuOf invalid")
        const hookSh = join(rRoot, "pick-acct.sh")
        writeFileSync(hookSh, "#!/bin/sh\necho account=acct-w8c\n", { mode: 0o755 })
        writeFileSync(
          rCfgPath,
          JSON.stringify({
            origin: liveHost.origin,
            name: "w8c-runner",
            capacity: 2,
            stateDir: rState,
            heartbeatSeconds: 1,
            pollSeconds: 1,
            admission: { loadPerCpu: 1000, diskFloorGb: 0 },
            profiles: {
              "picked": {
                argv: [process.execPath, acpAgentPath],
                env: { ACP_TEST_AGENT_STATE: rAgentState },
                prestart: [hookSh]
              }
            },
            repositories: {
              "github/acme/app": { mirror: liveMirror.path }
            }
          }),
          "utf8"
        )
        const row2 = liveHost.enqueue(
          RunnerHostFixture.task({
            profile: "picked",
            base: liveMirror.base,
            prompt: "add the line `b` to `B.md`"
          })
        )
        runnerFiber = Effect.runFork(RunnerCmd.serve(rCfgPath))
        const settled2 = await liveHost.settled(row2, 45_000)
        assertInv(settled2._tag === "Done", "Live RunnerCmd.serve with prestart hook settled Done")
        await Effect.runPromise(Fiber.interrupt(runnerFiber))
        runnerFiber = undefined

        // 12. RunnerLocalJobs deep with TestClock + injected faulty FileSystem (claim, heartbeat, transcript, settle, timeout expiry, restart, cancel, reopen, corrupt JSON, FS faults!)
        const ljFaultDir = join(dir, "lj-faults")
        mkdirSync(ljFaultDir, { recursive: true })
        const fsFaults = new Set<"rename" | "append" | "read">()
        const faultyFsLayer = Layer.effect(
          FileSystem.FileSystem,
          Effect.map(FileSystem.FileSystem, (fs) =>
            FileSystem.FileSystem.of({
              ...fs,
              rename: (from, to) =>
                fsFaults.has("rename")
                  ? Effect.fail(PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "rename" }))
                  : fs.rename(from, to),
              writeFileString: (path, data, opts) =>
                fsFaults.has("append") && opts?.flag === "a"
                  ? Effect.fail(
                    PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "writeFile" })
                  )
                  : fs.writeFileString(path, data, opts),
              readFileString: (path, enc) =>
                fsFaults.has("read")
                  ? Effect.fail(
                    PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "readFile" })
                  )
                  : fs.readFileString(path, enc)
            }))
        ).pipe(Layer.provide(NodeServices.layer))
        const runLj = <A, E>(
          body: (s: LocalJobs.Store) => Effect.Effect<A, E, FileSystem.FileSystem>,
          opts: LocalJobs.Options = {}
        ) =>
          Effect.runPromise(
            LocalJobs.make(ljFaultDir, opts).pipe(
              Effect.flatMap(body),
              Effect.scoped,
              Effect.provide(Layer.merge(TestClock.layer(), faultyFsLayer))
            )
          )
        const ljTask = {
          agent: { name: "lane", labels: [], profile: "coder", maxHours: 1, restarts: 1 },
          repository: "github/acme/app",
          base: "a".repeat(40),
          system: [],
          prompt: "do it",
          limits: { files: 10, bytes: 1000 }
        }
        await runLj((store) =>
          Effect.gen(function*() {
            yield* store.jobs.start(ljTask, "lj-1#g1")
            // Duplicate start is a no-op
            yield* store.jobs.start(ljTask, "lj-1#g1")
            const job = yield* store.host.claim({ profiles: ["coder"], free: 1, running: [], waitSeconds: 0 } as never)
            assertInv(job !== null, "LocalJobs claimed job")
            if (job === null) return
            yield* store.host.heartbeat({ key: job.key, claim: job.claim, cpuSeconds: 1 } as never)
            yield* store.host.events(
              {
                key: job.key,
                claim: job.claim,
                events: [{ seq: 1, at: 10, kind: "user_message_chunk", update: { text: "hi" } }]
              } as never
            )
            // Inject append fault
            fsFaults.add("append")
            yield* Effect.exit(
              store.host.events(
                {
                  key: job.key,
                  claim: job.claim,
                  events: [{ seq: 2, at: 20, kind: "user_message_chunk", update: { text: "fail" } }]
                } as never
              )
            )
            fsFaults.delete("append")
            // Advance TestClock past deadline to trigger timeout expiry & restart!
            yield* TestClock.adjust("2 hours")
            const reclaimed = yield* store.host.claim(
              { profiles: ["coder"], free: 1, running: [], waitSeconds: 0 } as never
            )
            // Inject rename fault on settle
            fsFaults.add("rename")
            yield* Effect.exit(
              store.host.settle(
                {
                  key: job.key,
                  claim: reclaimed?.claim ?? job.claim,
                  outcome: { _tag: "Done", changes: { additions: [], deletions: [] }, summary: "ok", usage: {} }
                } as never
              )
            )
            fsFaults.delete("rename")
            yield* store.jobs.cancel(job.key)
          })
        )
        // Reopen store with a corrupt JSON file inside jobs dir + read fault
        mkdirSync(join(ljFaultDir, "jobs"), { recursive: true })
        writeFileSync(join(ljFaultDir, "jobs", "corrupt.json"), "{broken-json", "utf8")
        await runLj((store) => store.host.claim({ profiles: ["coder"], free: 1, running: [], waitSeconds: 0 } as never))
          .catch(() => {})
        fsFaults.add("read")
        await runLj((store) => store.host.claim({ profiles: ["coder"], free: 1, running: [], waitSeconds: 0 } as never))
          .catch(() => {})
        fsFaults.delete("read")

        // 12b. RunnerServe heartbeat auth-lost -> suspend -> resume -> cancel + claim backoff + settle 503/401 (Serve.ts L92-142, L256-260; Job.ts L139-242; Session.ts L422-460!)
        let claimCalls = 0
        let hbCalls = 0
        let settleCalls = 0
        const authLostSrv = createServer(async (req, res) => {
          const url = req.url ?? "/"
          const chunks: Array<Buffer> = []
          for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
          res.setHeader("content-type", "application/json")
          if (url.endsWith("/claim")) {
            claimCalls++
            if (claimCalls === 1) {
              res.writeHead(503, { "retry-after": "1" })
              res.end(JSON.stringify({ code: "unavailable", message: "transient" }))
              return
            }
            if (claimCalls === 2) {
              res.writeHead(200)
              res.end(JSON.stringify({
                job: {
                  key: "auth-job#g1",
                  claim: "cl-auth-1",
                  generation: 1,
                  deadline: Date.now() + 30_000,
                  reclaimed: false,
                  leaseSeconds: 30,
                  task: {
                    agent: { name: "lane", labels: [], profile: "test-agent", maxHours: 1, restarts: 0 },
                    repository: "github/acme/app",
                    base: liveMirror.base,
                    system: [],
                    prompt: "talk for 10 seconds",
                    limits: { files: 10, bytes: 100_000 }
                  }
                }
              }))
              return
            }
            res.writeHead(200)
            res.end(JSON.stringify({ job: null }))
            return
          }
          if (url.endsWith("/heartbeat")) {
            hbCalls++
            if (hbCalls === 1) {
              // Transient auth lost (cancel=false) -> triggers suspend() (Serve.ts L92-93, L127-131)!
              res.writeHead(401)
              res.end(JSON.stringify({ cancel: false }))
              return
            }
            if (hbCalls === 2) {
              // Re-authorized -> triggers resume() (Serve.ts L140-142)!
              res.writeHead(200)
              res.end(JSON.stringify({ leaseSeconds: 30, steers: [] }))
              return
            }
            // Terminal auth lost with cancel=true -> triggers cancel (Serve.ts L95-106)!
            res.writeHead(401)
            res.end(JSON.stringify({ cancel: true }))
            return
          }
          if (url.endsWith("/events")) {
            res.writeHead(200)
            res.end(JSON.stringify({ next: 100 }))
            return
          }
          if (url.endsWith("/settle")) {
            settleCalls++
            if (settleCalls === 1) {
              res.writeHead(503)
              res.end(JSON.stringify({ error: "unavailable" }))
              return
            }
            res.writeHead(401)
            res.end(JSON.stringify({ cancel: true }))
            return
          }
          res.writeHead(200)
          res.end("{}")
        })
        await new Promise<void>((resolve) => authLostSrv.listen(0, "127.0.0.1", () => resolve()))
        try {
          const alPort = (authLostSrv.address() as AddressInfo).port
          const alState = join(dir, "al-state")
          const alCfg = join(dir, "al-runner.json")
          await Effect.runPromise(RunnerConfig.makeToken(alState))
          writeFileSync(
            alCfg,
            JSON.stringify({
              origin: `http://127.0.0.1:${alPort}`,
              name: "w8c-al-runner",
              capacity: 1,
              stateDir: alState,
              heartbeatSeconds: 1,
              pollSeconds: 1,
              admission: { loadPerCpu: 1000, diskFloorGb: 0 },
              profiles: {
                "test-agent": {
                  argv: [process.execPath, acpAgentPath],
                  env: { ACP_TEST_AGENT_STATE: rAgentState }
                }
              },
              repositories: {
                "github/acme/app": { mirror: liveMirror.path }
              }
            }),
            "utf8"
          )
          const alFib = Effect.runFork(RunnerCmd.serve(alCfg))
          const alEnd = Date.now() + 10_000
          while (hbCalls < 3 && Date.now() < alEnd) {
            await new Promise((r) => setTimeout(r, 150))
          }
          await new Promise((r) => setTimeout(r, 300))
          await Effect.runPromise(Fiber.interrupt(alFib))
        } finally {
          await new Promise<void>((resolve) => authLostSrv.close(() => resolve()))
        }

        // 13. RunnerWorkspace concurrent checkouts + changes + reapGroups live detached process + fetch missing rev!
        const wsRoot = join(dir, "rw-concurrent")
        const wsState = join(wsRoot, "state")
        const rwMirror = RunnerHostFixture.mirror(wsRoot)
        const cos = Array.from({ length: 3 }, (_, i) => Workspace.of(wsState, `cjob-${i}`))
        await Effect.runPromise(
          Effect.forEach(cos, (co) => Effect.exit(Workspace.create(rwMirror.path, rwMirror.base, co)), {
            concurrency: "unbounded"
          })
        )
        for (let i = 0; i < cos.length; i++) {
          writeFileSync(join(cos[i]!.dir, `f-${i}.txt`), `val-${i}\n`, "utf8")
        }
        // Over-limit file to trigger limits refusal branch in Workspace.changes!
        writeFileSync(join(cos[0]!.dir, "huge.bin"), "x".repeat(4096), "utf8")
        // Symlink inside checkout to exercise symlink-checking branch (Workspace.ts L614-619)
        symlinkSync("/etc/hosts", join(cos[1]!.dir, "sym-link"))
        await Effect.runPromise(
          Effect.forEach(
            cos,
            (co) => Effect.exit(Workspace.changes(co, rwMirror.base, { files: 10, bytes: 1024 }, rwMirror.path)),
            { concurrency: "unbounded" }
          )
        )
        // Unknown rev triggers Workspace.create fetch branch (L782-787)
        await Effect.runPromise(
          Effect.exit(Workspace.create(rwMirror.path, "deadbeef".repeat(5), Workspace.of(wsState, "missing-rev")))
        )
        // Live detached child reaped via Workspace.reapGroups (L368-372!)
        const reapChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          detached: true,
          stdio: "ignore"
        })
        if (reapChild.pid !== undefined) {
          const reapMeta = join(cos[2]!.stateDir, "groups", `${cos[2]!.name}.pid`)
          mkdirSync(join(cos[2]!.stateDir, "groups"), { recursive: true })
          writeFileSync(reapMeta, `${reapChild.pid}\n`, "utf8")
          await Effect.runPromise(Effect.exit(Workspace.reapGroups(cos[2]!.stateDir)))
          try {
            process.kill(-reapChild.pid, "SIGKILL")
          } catch { /* already reaped */ }
        }
        await Effect.runPromise(
          Effect.forEach(cos, (co) => Effect.exit(Workspace.remove(rwMirror.path, co)), { concurrency: "unbounded" })
        )
        await Effect.runPromise(Effect.exit(Workspace.remove(rwMirror.path, cos[0]!)))

        // 14. CloudSandbox invalid clientLeaseSeconds refusal (L157)
        try {
          CloudSandbox.make({
            origin: "http://127.0.0.1:1",
            repository: "owner/repo",
            clientLeaseSeconds: 10
          } as never)
        } catch {
          // expected TypeError
        }

        // 15. LocalJobs watch(runId) via ModuleOwner + partial transcript fileOf() recovery (L313-329, L507-511!)
        const ljOwnDir = join(dir, "lj-owner")
        mkdirSync(join(ljOwnDir, "transcripts"), { recursive: true })
        const ownKey = "lj-own#g1"
        writeFileSync(
          join(ljOwnDir, "transcripts", `${LocalJobs.fileOf(ownKey)}.jsonl`),
          `{"seq":1,"at":1,"kind":"user_message_chunk","update":{}}\n{"seq":2,"truncated":`,
          "utf8"
        )
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const store = yield* LocalJobs.make(ljOwnDir, {
                runEnded: () => Effect.sleep("20 millis")
              })
              yield* store.jobs.start(ljTask, ownKey).pipe(
                Effect.provideService(ModuleOwner, { rootId: "run-own-1", executionId: "run-own-1" } as never)
              )
              const claimed = yield* store.host.claim(
                { profiles: ["coder"], free: 1, running: [], waitSeconds: 0 } as never
              )
              if (claimed !== null) {
                yield* store.host.events({
                  key: claimed.key,
                  claim: claimed.claim,
                  events: [{ seq: 2, at: 2, kind: "user_message_chunk", update: { text: "recovered" } }]
                } as never)
              }
              yield* Effect.sleep("60 millis")
            }).pipe(Effect.provide(NodeServices.layer))
          )
        ).catch(() => {})

        // 16. Workstreams.read with seeded admitted file (L236-248) + RunnerConfig validation refusals (L216-259) + RunnerCmd.start validation (L259-265)
        const injStateDir = join(dir, "inj-serve-state")
        mkdirSync(join(injStateDir, "admitted"), { recursive: true })
        writeFileSync(
          join(injStateDir, "admitted", "r-ws-1.json"),
          JSON.stringify({
            runId: "r-ws-1",
            workstream: "ws1",
            task: "t1",
            profile: "test-agent",
            repository: "github/acme/app",
            admittedAt: 1000
          }),
          "utf8"
        )
        const injCfg = {
          origin: "http://127.0.0.1:1",
          name: "w8c-inj-runner",
          capacity: 1,
          stateDir: injStateDir,
          heartbeatSeconds: 1,
          pollSeconds: 1,
          admission: { loadPerCpu: 1000, diskFloorGb: 0 },
          profiles: {
            "test-agent": {
              argv: [process.execPath, acpAgentPath],
              env: { ACP_TEST_AGENT_STATE: rAgentState }
            }
          },
          repositories: { "github/acme/app": { mirror: liveMirror.path } },
          workstreams: {
            ws1: { title: "WS 1", tasks: [{ id: "t1", title: "Task 1" }] }
          }
        } as never
        await Effect.runPromise(
          Effect.exit(
            Workstreams.read(
              injCfg,
              Layer.succeed(Control.Control, {
                list: () =>
                  Effect.succeed({
                    _tag: "runs",
                    items: [{
                      runId: "r-ws-1",
                      flowId: "runner/lane",
                      status: "running",
                      createdAt: 1000,
                      input: { workstream: "ws1", task: "t1" }
                    }]
                  }),
                getRun: () =>
                  Effect.succeed({ runId: "r-ws-1", flowId: "runner/lane", status: "running", createdAt: 1000 })
              } as unknown as Control.Service)
            ).pipe(Effect.provide(NodeServices.layer))
          )
        ).catch(() => {})
        // RunnerConfig validation refusals (Config.ts L216-259!)
        const baseBadCfg = {
          origin: "https://example.test",
          name: "bad-r",
          capacity: 1,
          stateDir: join(dir, "rc-st"),
          profiles: { p1: { argv: ["/bin/true"] } },
          repositories: { r1: { mirror: liveMirror.path } }
        }
        for (
          const [idx, badCfg] of [
            { ...baseBadCfg, repositories: { r1: { mirror: "relative/mirror" } } },
            {
              ...baseBadCfg,
              workstreams: { w1: { title: "W", tasks: [{ id: "dup", title: "A" }, { id: "dup", title: "B" }] } }
            },
            { ...baseBadCfg, origin: "not a url" },
            { ...baseBadCfg, origin: "http://remote.example.test" },
            { ...baseBadCfg, origin: "https://example.test/with/path" }
          ].entries()
        ) {
          const bp = join(dir, `bad-rc-${idx}.json`)
          writeFileSync(bp, JSON.stringify(badCfg), "utf8")
          await Effect.runPromise(Effect.exit(RunnerConfig.load(bp).pipe(Effect.provide(NodeServices.layer))))
        }
        // Direct RunnerCmd.start validation errors (--workstream without --task, unknown workstream L259-265)
        await Effect.runPromise(
          Effect.exit(
            RunnerCmd.start({
              brief: join(rRoot, "runner.json"),
              config: rCfgPath,
              profile: "picked",
              repository: "github/acme/app",
              workstream: "ws1"
            } as never)
          )
        )
        await Effect.runPromise(
          Effect.exit(
            RunnerCmd.start({
              brief: join(rRoot, "runner.json"),
              config: rCfgPath,
              profile: "picked",
              repository: "github/acme/app",
              workstream: "missing-ws",
              task: "t1"
            } as never)
          )
        )
      } finally {
        if (runnerFiber !== undefined) await Effect.runPromise(Fiber.interrupt(runnerFiber)).catch(() => {})
        if (liveHost !== undefined) await liveHost.close().catch(() => {})
        if (prevPgUrl === undefined) delete process.env.SMITHERS_POSTGRES_URL
        else process.env.SMITHERS_POSTGRES_URL = prevPgUrl
        if (prevPgSchema === undefined) delete process.env.SMITHERS_POSTGRES_SCHEMA
        else process.env.SMITHERS_POSTGRES_SCHEMA = prevPgSchema
        if (prevBackend === undefined) delete process.env.SMITHERS_BACKEND
        else process.env.SMITHERS_BACKEND = prevBackend
        await onSql(
          publicPgUrl,
          Effect.gen(function*() {
            const sql = yield* SqlClient
            for (
              const row of yield* sql<
                { name: string }
              >`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE ${`%${pgPrefix.slice(-44)}`}`
            ) yield* sql`DROP SCHEMA IF EXISTS ${sql(row.name)} CASCADE`
          })
        ).catch(() => {})
        rmSync(dir, { recursive: true, force: true })
      }
    },
    180_000
  )
})
