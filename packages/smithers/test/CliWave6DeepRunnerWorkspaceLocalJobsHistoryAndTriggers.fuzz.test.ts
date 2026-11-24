import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentRunner from "@smthrs/agent/AgentRunner"
import { CaseExecutor, Suite } from "@smthrs/evals"
import { Fuzz } from "@smthrs/fuzz"
import { Binding, Scorer } from "@smthrs/scorers"
import { Arbitrary, Cause, Deferred, Effect, Fiber, Latch, Option, Queue, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as Evaluation from "../src/evaluation/Evaluation.ts"
import * as History from "../src/history/History.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Host from "../src/runner/Host.ts"
import * as LocalJobs from "../src/runner/LocalJobs.ts"
import * as Session from "../src/runner/Session.ts"
import * as Workspace from "../src/runner/Workspace.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261132")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeControl = () =>
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
      steers: yield* Queue.unbounded<AgentRunner.Steer>(),
      delivered: new Set<string>(),
      stats: {}
    } satisfies Session.Control
  })

describe("@smthrs/cli Wave-6B Deep Runner Session/Workspace/LocalJobs, RunnerCmd, Evaluation & History fuzz invariants", () => {
  it(
    "runner/Workspace lifecycle (real jj repo create/changes/sweep/remove/discard) & runner/Session.work end-to-end ACP execution uphold invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-run-ws-sess-"))
      const mirror = join(tmp, "mirror")
      const stateDir = join(tmp, "state")
      mkdirSync(mirror, { recursive: true })
      mkdirSync(stateDir, { recursive: true })

      try {
        // 1. Fuzz trustedRemote & spawnFailureOf invariants
        const urlArb = Arbitrary.schema(
          Schema.Union([
            Schema.Literal("https://github.com/acme/demo.git"),
            Schema.Literal("http://127.0.0.1:8080/repo.git"),
            Schema.Literal("ssh://git@github.com/acme/demo.git"),
            Schema.Literal("file:///etc/passwd"),
            Schema.Literal("not a url"),
            Schema.Literal("https://user:pass@github.com/acme/demo.git")
          ])
        )
        const rep = await Effect.runPromise(
          Fuzz.run(
            urlArb,
            (u) =>
              Effect.sync(() => {
                const parsed = Workspace.trustedRemote(u)
                if (u.startsWith("file://") || u === "not a url") {
                  assertInv(parsed === undefined, "untrusted remote rejected")
                }
                const sf = Session.spawnFailureOf(
                  Cause.fail(Object.assign(new Error(`spawn ${tmp}/bin failed`), { code: "ENOENT" }))
                )
                assertInv(sf.code === "ENOENT" && !sf.reason.includes(tmp), "spawnFailureOf redacts absolute paths")
                return true
              }),
            { executions: Math.min(executions, 30), seed }
          )
        )
        expect(rep._tag).toBe("Passed")

        // 2. Real jj repo mirror + Workspace.create / changes / scheduleRemoval / sweep / remove / discard / watchGroups / reapGroups
        execFileSync("jj", ["git", "init", mirror], { stdio: "ignore" })
        writeFileSync(join(mirror, "README.md"), "# demo\n")
        execFileSync("jj", ["-R", mirror, "describe", "-m", "init"], { stdio: "ignore" })
        execFileSync("jj", ["-R", mirror, "new"], { stdio: "ignore" })
        const baseCommit = execFileSync("jj", ["-R", mirror, "log", "--no-graph", "-r", "@-", "-T", "commit_id"], {
          encoding: "utf8"
        }).trim()

        const authEnv = Workspace.gitAuthEnv(
          { remote: "https://github.com/acme/demo.git", token: "ghs_test_123" } as any
        )
        expect(authEnv["GIT_TERMINAL_PROMPT"]).toBe("0")
        expect(Workspace.fetchStoreOf(stateDir, mirror)).toContain(stateDir)
        expect((Workspace.commandEnv as any)({ FOO: "1" }, { BAR: "2" })["BAR"]).toBe("2")

        const ck1 = Workspace.of(stateDir, "job-alpha-1")
        await Effect.runPromise(Workspace.create(mirror, baseCommit, ck1))
        expect(Workspace.exists(ck1)).toBe(true)
        writeFileSync(join(ck1.dir, "added.txt"), "hello change\n")
        const diff = await Effect.runPromise(
          Workspace.changes(ck1, baseCommit, { files: 100, bytes: 1024 * 1024 }, mirror)
        )
        expect(diff).toBeDefined()

        await Effect.runPromise(Workspace.scheduleRemoval(mirror, ck1))
        await Effect.runPromise(Workspace.sweep(stateDir))
        expect(Workspace.exists(ck1)).toBe(false)

        const ck2 = Workspace.of(stateDir, "job-beta-2")
        await Effect.runPromise(Workspace.create(mirror, baseCommit, ck2))
        await Effect.runPromise(Workspace.remove(mirror, ck2))
        expect(Workspace.exists(ck2)).toBe(false)

        await Effect.runPromise(Workspace.watchGroups(stateDir))
        await Effect.runPromise(Workspace.reapGroups(stateDir))

        // 3. Real fake ACP agent script + prestart hook -> Session.work end-to-end!
        const prestartScript = join(tmp, "prestart.cjs")
        writeFileSync(
          prestartScript,
          `#!${process.execPath}
if (process.env.FAIL_PRESTART === "1") process.exit(1)
console.log("account=acct-alpha")
console.log("INJECTED_KEY=secret_val_42")
`
        )
        chmodSync(prestartScript, 0o755)

        const agentScript = join(tmp, "fake-acp.cjs")
        writeFileSync(
          agentScript,
          `#!${process.execPath}
const readline = require("node:readline")
const fs = require("node:fs")
const path = require("node:path")
const mode = process.env.FAKE_AGENT_MODE || "ok"
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n")
rl.on("line", (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-sess-1" } })
  } else if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  } else if (msg.method === "session/prompt") {
    if (mode === "crash") {
      process.exit(1)
    }
    if (mode === "hang") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working..." } } } })
      return
    }
    fs.writeFileSync(path.join(process.cwd(), "agent-output.txt"), "done by agent\\n")
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Finished the task cleanly." } } } })
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp-sess-1", update: { sessionUpdate: "usage_update", size: 1200, used: 300, cost: { amount: 0.01, currency: "USD" } } } })
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } })
  } else if (msg.method === "session/cancel") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} })
  }
})
`
        )
        chmodSync(agentScript, 0o755)

        const uploadedTranscripts: Array<unknown> = []
        const fakeHost = Host.Host.of({
          claim: () => Effect.succeed(Option.none()),
          heartbeat: () => Effect.succeed({ cancel: false, steers: [] }),
          transcript: (_k: any, _c: any, events: any) =>
            Effect.sync(() => {
              uploadedTranscripts.push(...events)
            }),
          settle: () => Effect.void,
          credential: () => Effect.succeed(Option.none())
        } as any)

        const baseConfig: any = {
          name: "runner-test",
          concurrency: 2,
          stateDir,
          lanesRoot: stateDir,
          heartbeatSeconds: 10,
          pollSeconds: 2,
          repositories: { demo: { mirror, remote: "https://github.com/acme/demo.git" } },
          profiles: {
            ok: {
              argv: [process.execPath, agentScript],
              prestart: [process.execPath, prestartScript],
              secretEnv: ["INJECTED_KEY"],
              env: { FAKE_AGENT_MODE: "ok" }
            },
            badPrestart: {
              argv: [process.execPath, agentScript],
              prestart: [process.execPath, prestartScript],
              env: { FAIL_PRESTART: "1" }
            },
            hang: {
              argv: [process.execPath, agentScript],
              env: { FAKE_AGENT_MODE: "hang" }
            },
            crashRetry: {
              argv: [process.execPath, agentScript],
              env: { FAKE_AGENT_MODE: "crash" },
              retryOn: ["exit"]
            }
          },
          workstreams: {}
        }

        const makeJob = (
          origin: string,
          repo = "demo",
          profile = "ok",
          deadlineMs = Date.now() + 30_000
        ): Session.JobPayload => ({
          key: `${origin}#g1` as any,
          generation: 1,
          claim: "claim-1",
          deadline: deadlineMs,
          task: {
            repository: repo,
            base: baseCommit,
            system: ["Be brief."],
            prompt: "Write agent-output.txt",
            agent: { profile },
            limits: { files: 100, bytes: 1024 * 1024 }
          } as any
        })

        // 3a. Missing repo -> Failed("workspace"), missing profile -> Failed("refused")
        const ctrl0 = await Effect.runPromise(makeControl())
        const outNoRepo = await Effect.runPromise(
          Session.work(baseConfig, makeJob("j-norepo", "missing"), ctrl0).pipe(
            Effect.provideService(Host.Host, fakeHost)
          )
        )
        expect(outNoRepo._tag).toBe("Failed")
        const outNoProf = await Effect.runPromise(
          Session.work(baseConfig, makeJob("j-noprof", "demo", "missing"), ctrl0).pipe(
            Effect.provideService(Host.Host, fakeHost)
          )
        )
        expect(outNoProf._tag).toBe("Failed")

        // 3b. Prestart exits non-zero -> Failed("refused")
        const ctrlPre = await Effect.runPromise(makeControl())
        const outBadPre = await Effect.runPromise(
          Session.work(baseConfig, makeJob("j-badpre", "demo", "badPrestart"), ctrlPre).pipe(
            Effect.provideService(Host.Host, fakeHost)
          )
        )
        expect(outBadPre._tag).toBe("Failed")

        // 3c. Happy path ACP session end-to-end -> Done with diff & summary!
        const ctrlOk = await Effect.runPromise(makeControl())
        const outOk = await Effect.runPromise(
          Session.work(baseConfig, makeJob("j-happy", "demo", "ok"), ctrlOk).pipe(
            Effect.provideService(Host.Host, fakeHost)
          )
        )
        expect(outOk._tag).toBe("Done")
        expect((ctrlOk.stats as any).account).toBe("acct-alpha")

        // 3d. Crash with retryOn: ["exit"] -> Retryable!
        const ctrlCrash = await Effect.runPromise(makeControl())
        const outCrash = await Effect.runPromise(
          Session.work(baseConfig, makeJob("j-crash", "demo", "crashRetry"), ctrlCrash).pipe(
            Effect.provideService(Host.Host, fakeHost)
          )
        )
        expect(outCrash._tag).toBe("Retryable")

        // 3e. Hanging agent cancelled via control.cancel -> Cancelled!
        const ctrlCancel = await Effect.runPromise(makeControl())
        setTimeout(() => {
          Effect.runSync(Deferred.succeed(ctrlCancel.cancel, undefined))
        }, 150)
        const outCancel = await Effect.runPromise(
          Session.work(baseConfig, makeJob("j-cancel", "demo", "hang"), ctrlCancel).pipe(
            Effect.provideService(Host.Host, fakeHost)
          )
        )
        expect(outCancel._tag).toBe("Cancelled")
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "runner/LocalJobs full lifecycle, commands/Runner statusServer HTTP, Evaluation & History uphold invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-lj-ev-hist-"))
      const jobsDir = join(tmp, "local-jobs")
      const evalRoot = join(tmp, "eval-proj")
      const histRoot = join(tmp, "hist-proj")
      mkdirSync(join(jobsDir, "jobs"), { recursive: true })
      mkdirSync(join(evalRoot, "evals"), { recursive: true })
      mkdirSync(join(histRoot, ".flows"), { recursive: true })

      try {
        // 1. LocalJobs: stray temp cleanup + corrupt file handling + full start/claim/heartbeat/steer/transcript/settle/cancel/runEnded
        writeFileSync(join(jobsDir, "jobs", ".stray.tmp"), "partial")
        writeFileSync(join(jobsDir, "jobs", "corrupt.json"), "{broken json")

        const runEndedDef = await Effect.runPromise(Deferred.make<void>())
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const store = yield* LocalJobs.make(jobsDir, {
                runEnded: () => Deferred.await(runEndedDef)
              })
              const task: any = {
                repository: "demo",
                base: "a".repeat(40),
                system: [],
                prompt: "do work",
                agent: { name: "agent-1", labels: [], profile: "ok", maxHours: 1, restarts: 0 },
                limits: { files: 10, bytes: 1024 }
              }
              yield* store.jobs.start(task, "orig-1#g1" as any)
              const job = yield* store.host.claim({ runner: "runner-1", profiles: ["ok"], labels: [] } as any)
              expect(job).not.toBeNull()
              if (job !== null) {
                const hb = yield* store.host.heartbeat(
                  { key: job.key, claim: job.claim, delivered: [], stats: { account: "a1" } } as any
                )
                expect(hb.cancel).toBe(false)
                yield* store.host.events({
                  key: job.key,
                  claim: job.claim,
                  events: [{ seq: 0, at: Date.now(), kind: "text", update: { text: "hi" } }]
                } as any)
                yield* store.host.settle({
                  key: job.key,
                  claim: job.claim,
                  outcome: { _tag: "Done", summary: "ok", changes: { additions: [], deletions: [] }, usage: {} }
                } as any)
                const standing = yield* store.jobs.status("orig-1#g1" as any)
                expect(standing._tag).toBe("Ended")
              }
              // Start a second job and cancel it via jobs.cancel
              yield* store.jobs.start(task, "orig-2#g1" as any)
              yield* store.jobs.cancel("orig-2#g1" as any)
              const st2 = yield* store.jobs.status("orig-2#g1" as any)
              expect(st2._tag).toBe("Ended")
              yield* Deferred.succeed(runEndedDef, undefined)
            })
          ).pipe(Effect.provide(NodeServices.layer))
        )

        // 2. commands/Runner: renderStatus + status error on remote origin + live statusServer HTTP!
        expect(RunnerCmd.renderStatus([])).toContain("No workstreams")
        const rendered = RunnerCmd.renderStatus([
          {
            id: "ws-1",
            title: "Alpha",
            goal: "Ship it",
            status: "running",
            progress: { done: 1, total: 2 },
            tasks: [
              {
                id: "t1",
                title: "First",
                status: "done",
                owners: [{ runId: "r-1", profile: "ok", status: "completed" }]
              },
              { id: "t2", title: "Second", status: "open", owners: [] }
            ]
          } as any
        ])
        expect(rendered).toContain("Alpha")
        expect(rendered).toContain("no lane")

        const runnerCfgRemote = join(tmp, "runner-remote.json")
        writeFileSync(
          runnerCfgRemote,
          JSON.stringify({
            origin: "https://smithers.sh",
            name: "r1",
            repositories: {},
            profiles: { ok: { argv: ["echo"] } }
          })
        )
        const stErr = await Effect.runPromise(Effect.exit(RunnerCmd.status(runnerCfgRemote)))
        expect(stErr._tag).toBe("Failure")

        const runnerCfgLocal = join(tmp, "runner-local.json")
        writeFileSync(
          runnerCfgLocal,
          JSON.stringify({
            name: "local-r",
            stateDir: join(tmp, "local-r-state"),
            repositories: {},
            profiles: { ok: { argv: ["echo"] } },
            workstreams: {
              ws1: { title: "WS1", goal: "Goal 1", tasks: [{ id: "t1", title: "Task 1" }] }
            }
          })
        )
        const localWs = await Effect.runPromise(RunnerCmd.status(runnerCfgLocal))
        expect(localWs.length).toBe(1)

        // 3. Evaluation: list, load, escaping refusal, broken module refusal, publishJson, writeJson, execute (inline), readRun, baseline, compare!
        expect(Evaluation.localRoot({ root: evalRoot })).toBe(evalRoot)
        expect(() => Evaluation.localRoot({ root: evalRoot, remote: "https://smithers.sh" })).toThrow()

        const evalFile = join(evalRoot, "evals", "sample.eval.mjs")
        writeFileSync(evalFile, "export default { invalid: true }\n")
        const listed = await Evaluation.list(evalRoot)
        expect(listed.map((e) => e.name)).toEqual(["sample"])
        await expect(Evaluation.load(evalRoot, "../escape.eval.mjs")).rejects.toThrow()
        await expect(Evaluation.load(evalRoot, "sample")).rejects.toThrow()

        // Real Suite + CaseExecutor inline execute + publishJson/readRun/baseline/compare
        const target = { name: "wave6-target" }
        const scorer = Scorer.make({
          id: "cli/wave6/exact",
          version: "1",
          name: "exact",
          score: () => Effect.succeed({ score: 1 })
        })
        const suite = await Effect.runPromise(
          Suite.make({
            name: "wave6-suite",
            concurrency: 1,
            cases: [{ name: "c1", input: { x: 1 }, expected: { y: 2 } }],
            bindings: [Binding.make({ scorer, appliesTo: target })]
          })
        )
        const execSvc = CaseExecutor.make((entry) =>
          Effect.succeed({ output: entry.expected, stepKey: "step-1", latencyMs: 1, target })
        )
        const art = await Evaluation.execute(suite, execSvc, { runId: "eval-run-1", at: new Date().toISOString() })
        expect(art.suite).toBe("wave6-suite")
        const roundTripped = Evaluation.runOf(art)
        expect(roundTripped.suite).toBe("wave6-suite")

        // Also exercise durable execute with root!
        const artDurable = await Evaluation.execute(suite, execSvc, {
          runId: "eval-run-2",
          at: new Date().toISOString(),
          root: evalRoot
        })
        expect(artDurable.suite).toBe("wave6-suite")
        const durableScores = await Evaluation.scores(evalRoot, "eval-run-2")
        expect(durableScores).toBeDefined()

        const outPath = Evaluation.runPath(evalRoot, "eval-run-1")
        await Effect.runPromise(Evaluation.publishJson(outPath, JSON.stringify(art), false))
        const dupExit = await Effect.runPromise(
          Effect.exit(Evaluation.publishJson(outPath, JSON.stringify(art), false))
        )
        expect(dupExit._tag).toBe("Failure")
        await Effect.runPromise(Evaluation.publishJson(outPath, JSON.stringify(art), true))
        const readBack = await Evaluation.readRun(evalRoot, "eval-run-1")
        expect(readBack.runId).toBe("eval-run-1")

        const baseJson = await Evaluation.baseline(art)
        const basePath = Evaluation.defaultBaselinePath(evalRoot, "wave6-suite")
        await Evaluation.writeJson(basePath, baseJson, true)
        const baseRead = await Evaluation.readBaseline(basePath)
        const cmp = await Evaluation.compare(art, baseRead)
        expect(cmp).toBeDefined()

        // 4. History.reconcile & History.prepare on real local SQLite workspace
        await History.reconcile(histRoot)
        const prep = await History.prepare(histRoot, "run-hist-1")
        expect(prep.executionRoot).toBeTruthy()
        await expect(History.read(histRoot, "nonexistent-run", {}, false)).rejects.toThrow()
        await expect(History.preview(histRoot, "nonexistent-run", {})).rejects.toThrow()
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )
})
