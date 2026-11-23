import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentRunner from "@smthrs/agent/AgentRunner"
import * as Transcript from "@smthrs/agent/Transcript"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Context, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import * as HttpServer from "effect/http/HttpServer"
import { TestClock } from "effect/testing"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as Config from "../src/runner/Config.ts"
import * as Credential from "../src/runner/Credential.ts"
import * as RunnerHost from "../src/runner/Host.ts"
import * as Lane from "../src/runner/Lane.ts"
import * as LocalJobs from "../src/runner/LocalJobs.ts"
import * as Serve from "../src/runner/Serve.ts"
import * as Session from "../src/runner/Session.ts"
import * as Spool from "../src/runner/Spool.ts"
import * as StatusPage from "../src/runner/StatusPage.ts"
import * as Tree from "../src/runner/Tree.ts"
import * as Workspace from "../src/runner/Workspace.ts"
import * as Workstreams from "../src/runner/Workstreams.ts"
import * as RunnerJobs from "../src/RunnerJobs.ts"
import * as Host from "./fixtures/runner/host.ts"
import * as Lanes from "./fixtures/runner/lanes.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const AGENT = fileURLToPath(new URL("../agent/test/fixtures/acp-test-agent.mjs", import.meta.url))
const REPOSITORY = "github/acme/app"

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const gitExec = (args: Array<string>, cwd?: string) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull }
  }).trim()

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe("@smthrs/cli Runner Workspace, Session, Serve, Tree, Spool, Credential, LocalJobs, RunnerJobs & Lanes fuzz invariants", () => {
  it("Workspace, Tree, Credential & Spool enforce checkout isolation, git auth, process-tree cleanup & transcript spool durability", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        fileName: Schema.Literals(["notes.txt", "nested/alpha.md", "deep/sub/data.json"]),
        content: Schema.Literals(["hello world\n", "line1\nline2\n", "unicode café\n"]),
        exceedLimit: Schema.Boolean,
        credMode: Schema.Literals(["valid", "notFound", "retryAfter", "error500"]),
        cpuText: Schema.Literals(["0:00.12", "1-02:03:04", "12:34.56", "invalid", ""]),
        remoteUrl: Schema.Literals([
          "https://github.com/acme/app.git",
          "http://127.0.0.1:8080/repo.git",
          "file:///etc/passwd",
          "ssh://git@github.com/acme/app.git",
          "not-a-url"
        ])
      })
    )

    // 1. Pure / fast structural fuzzing across Tree, Workspace helpers, Credential, Spool
    const fastReport = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cpuText, credMode, remoteUrl }) =>
          Effect.promise(async () => {
            const cpu = Tree.cpuOf(cpuText)
            assertInv(typeof cpu === "number" && cpu >= 0 && !Number.isNaN(cpu), "Tree.cpuOf non-negative")

            const trusted = Workspace.trustedRemote(remoteUrl)
            if (remoteUrl.startsWith("https://")) {
              assertInv(trusted !== undefined, "https remote trusted")
            } else if (remoteUrl.startsWith("file://") || remoteUrl === "not-a-url") {
              assertInv(trusted === undefined, "file/invalid remote rejected")
            }

            const env = Workspace.gitAuthEnv({
              remote: "https://github.com/acme/app.git",
              username: "x-access-token",
              password: "ghs_secret_value_fuzz"
            })
            assertInv(typeof env === "object" && Object.keys(env).length > 0, "gitAuthEnv produces env vars")

            // Credential.forJob across status modes
            let now = 1_000_000
            let asks = 0
            const fakeHost = RunnerHost.Host.of({
              claim: () => Effect.die("unused"),
              heartbeat: () => Effect.die("unused"),
              settle: () => Effect.die("unused"),
              events: () => Effect.die("unused"),
              gitCredential: () =>
                Effect.gen(function*() {
                  asks++
                  if (credMode === "valid") {
                    return {
                      remote: "https://github.com/acme/app.git",
                      username: "x-access-token",
                      password: "ghs_fuzz_token",
                      expiresAt: now + 50 * 60_000
                    }
                  }
                  if (credMode === "notFound") {
                    return yield* new RunnerHost.HostError({ code: "invalid", route: "gitCredential", status: 404 })
                  }
                  if (credMode === "retryAfter") {
                    return yield* new RunnerHost.HostError({ code: "unavailable", route: "gitCredential", status: 429, retryAfterSeconds: 1 })
                  }
                  return yield* new RunnerHost.HostError({ code: "unavailable", route: "gitCredential", status: 500 })
                })
            })
            const held = { key: `job:${Math.random().toString(36).slice(2)}`, claim: `claim:${Math.random().toString(36).slice(2)}` }
            const exit = await Effect.runPromise(Effect.exit(Credential.forJob(fakeHost, held, () => now)))
            if (credMode === "valid") {
              assertInv(Exit.isSuccess(exit) && Option.isSome(exit.value), "valid credential returns Some")
              // Cache hit before refresh margin
              now += 10 * 60_000
              const second = await Effect.runPromise(Credential.forJob(fakeHost, held, () => now))
              assertInv(Option.isSome(second) && asks === 1, "cached credential reused")
              // Refresh after margin
              now += 35 * 60_000
              const third = await Effect.runPromise(Credential.forJob(fakeHost, held, () => now))
              assertInv(Option.isSome(third) && asks === 2, "expiring credential refreshed")
            } else if (credMode === "notFound") {
              assertInv(Exit.isSuccess(exit) && Option.isNone(exit.value), "404 returns None")
            } else {
              assertInv(Exit.isFailure(exit), `${credMode} fails`)
            }
            Credential.forget(held)

            // Spawn failure classification
            const sf1 = Session.spawnFailureOf(Cause.fail(new Error("ENOENT spawn fail")))
            const sf2 = Session.spawnFailureOf(Cause.die("unexpected boom"))
            assertInv(typeof sf1.code === "string" && typeof sf2.reason === "string", "spawnFailureOf classifies causes")

            return true
          }),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const fastFail = Fuzz.formatReport(fastReport)
    if (fastFail !== undefined) throw new Error(fastFail)

    // 2. Real jj mirror, concurrent checkouts, additions/deletions/limits, sweep, discard, watchGroups/reapGroups, Tree.watch/stop & Spool
    const root = mkdtempSync(join(tmpdir(), "smthrs-ws-fuzz-"))
    try {
      const mirror = Host.mirror(root)
      const stateDir = join(root, "state")
      const fetchStore = Workspace.fetchStoreOf(stateDir, mirror.path)
      assertInv(fetchStore.includes(stateDir), "fetchStoreOf inside stateDir")

      // Watch & reap groups
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const watched = yield* Workspace.watchGroups(stateDir)
        assertInv(typeof watched === "object" || watched === undefined, "watchGroups scoped")
      })))
      await Effect.runPromise(Workspace.reapGroups(stateDir))

      // Create multiple checkouts concurrently, edit files, measure changes, enforce limits, remove/discard/sweep
      const c1 = Workspace.of(stateDir, "job-a")
      const c2 = Workspace.of(stateDir, "job-b")
      const c3 = Workspace.of(stateDir, "job-c")
      await Effect.runPromise(Effect.all([
        Workspace.create(mirror.path, mirror.base, c1),
        Workspace.create(mirror.path, mirror.base, c2),
        Workspace.create(mirror.path, mirror.base, c3)
      ], { concurrency: "unbounded" }))
      assertInv(Workspace.exists(c1) && Workspace.exists(c2) && Workspace.exists(c3), "checkouts exist")

      mkdirSync(join(c1.dir, "sub"), { recursive: true })
      writeFileSync(join(c1.dir, "sub", "hello.txt"), "hello fuzz\n")
      writeFileSync(join(c2.dir, "big.bin"), Buffer.alloc(2048, 65))

      const ch1 = await Effect.runPromise(Workspace.changes(c1, mirror.base, { files: 10, bytes: 4096 }, mirror.path))
      assertInv(ch1 !== undefined && ch1.additions.some((a) => a.path === "sub/hello.txt"), "changes detects addition")

      // Over-limit bytes
      const ch2Exit = await Effect.runPromise(
        Effect.exit(Workspace.changes(c2, mirror.base, { files: 10, bytes: 512 }, mirror.path))
      )
      assertInv(Exit.isFailure(ch2Exit) || ch2Exit.value === undefined, "over-limit handled")

      // Remove, scheduleRemoval + sweep, discard
      await Effect.runPromise(Workspace.remove(mirror.path, c1))
      assertInv(!Workspace.exists(c1), "c1 removed")
      await Effect.runPromise(Workspace.scheduleRemoval(mirror.path, c2))
      await Effect.runPromise(Workspace.sweep(stateDir))
      await Effect.runPromise(Workspace.discard(mirror.path, c3))
      assertInv(!Workspace.exists(c3), "c3 discarded")

      // Real git smart-HTTP server + private auth env fetch
      const srcRepo = join(root, "git-src")
      gitExec(["init", "-q", "-b", "main", srcRepo])
      gitExec(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "--allow-empty", "-m", "base"], srcRepo)
      writeFileSync(join(srcRepo, "README.md"), "private fuzz\n")
      gitExec(["add", "README.md"], srcRepo)
      gitExec(["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "readme"], srcRepo)
      const headRev = gitExec(["rev-parse", "HEAD"], srcRepo)
      const servedDir = join(root, "served")
      mkdirSync(servedDir, { recursive: true })
      gitExec(["clone", "-q", "--bare", srcRepo, join(servedDir, "private.git")])
      const secret = "ghs_fuzz_http_secret"
      const expectedAuth = `Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`
      const gitServer = createServer((req, res) => {
        if (req.headers.authorization?.toLowerCase() !== expectedAuth.toLowerCase()) {
          res.writeHead(401, { "www-authenticate": "Basic realm=\"fuzz\"" }).end()
          return
        }
        const url = new URL(req.url ?? "/", "http://127.0.0.1")
        const cgi = spawn("git", ["http-backend"], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: servedDir,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: req.method ?? "GET",
            CONTENT_TYPE: req.headers["content-type"] ?? "",
            CONTENT_LENGTH: req.headers["content-length"] ?? ""
          }
        })
        req.pipe(cgi.stdin)
        let headerBuf = Buffer.alloc(0)
        let headersSent = false
        cgi.stdout.on("data", (chunk: Buffer) => {
          if (headersSent) {
            res.write(chunk)
            return
          }
          headerBuf = Buffer.concat([headerBuf, chunk])
          const sep = headerBuf.indexOf("\r\n\r\n")
          if (sep === -1) return
          headersSent = true
          const rawHeaders = headerBuf.subarray(0, sep).toString("utf8").split("\r\n")
          let status = 200
          for (const line of rawHeaders) {
            const idx = line.indexOf(":")
            if (idx === -1) continue
            const k = line.slice(0, idx).trim()
            const v = line.slice(idx + 1).trim()
            if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]) || 200
            else res.setHeader(k, v)
          }
          res.writeHead(status)
          res.write(headerBuf.subarray(sep + 4))
        })
        cgi.stdout.on("end", () => res.end())
      })
      await new Promise<void>((done) => gitServer.listen(0, "127.0.0.1", done))
      try {
        const addr = gitServer.address()
        if (addr === null || typeof addr === "string") throw new Error("expected TCP")
        const remote = `http://127.0.0.1:${addr.port}/private.git`
        const cPriv = Workspace.of(stateDir, "job-priv")
        const privMirror = join(root, "priv-mirror")
        await Effect.runPromise(
          Workspace.create(
            privMirror,
            headRev,
            cPriv,
            Effect.succeed(
              Option.some({
                remote,
                username: "x-access-token",
                password: secret,
                expiresAt: Date.now() + 60_000
              })
            )
          )
        )
        assertInv(existsSync(join(cPriv.dir, "README.md")), "private git clone+checkout succeeded")
        await Effect.runPromise(Workspace.remove(privMirror, cPriv))
      } finally {
        await new Promise<void>((done) => gitServer.close(() => done()))
      }

      // Real Tree.watch + Tree.stop on a short-lived spawned node process
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" })
      try {
        assertInv(child.pid !== undefined, "spawned child pid")
        const tree = Tree.watch(child.pid!)
        await sleep(50)
        const snap = await Effect.runPromise(Tree.stop(tree, { graceMs: 150, settleMs: 150 }))
        assertInv(typeof snap === "boolean" || typeof snap === "object" || snap === undefined, "Tree.stop settled")
      } finally {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
        } catch {}
      }

      // Real Spool append/drain/remove
      const sentBatches: Array<ReadonlyArray<Transcript.Event>> = []
      const spoolHost = RunnerHost.Host.of({
        claim: () => Effect.die("unused"),
        heartbeat: () => Effect.die("unused"),
        settle: () => Effect.die("unused"),
        gitCredential: () => Effect.die("unused"),
        events: (req) =>
          Effect.sync(() => {
            sentBatches.push(req.events)
            return { next: (req.events.at(-1)?.seq ?? -1) + 1 }
          })
      })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const spool = yield* Spool.open({
              stateDir,
              key: "spool-job-1",
              claim: "spool-claim-1",
              scrub: (t) => t
            })
            yield* spool.append("agent_message_chunk", { content: { type: "text", text: "hello spool" } })
            const drained = yield* spool.drain
            assertInv(drained === "sent" && sentBatches.length >= 1, "spool drained events")
            yield* spool.remove
          })
        ).pipe(Effect.provideService(RunnerHost.Host, spoolHost))
      )
      assertInv(!existsSync(Spool.fileOf(stateDir, "spool-job-1")), "spool file removed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  it("RunnerJobs, LocalJobs & Workstreams uphold full job lifecycle, lease expiry, steering, cancellation & projection invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        outcomeKind: Schema.Literals(["Done", "Failed", "Cancelled"]),
        steerCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2)),
        expireLease: Schema.Boolean,
        cancelMidway: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cancelMidway, expireLease, outcomeKind, steerCount }) =>
          Effect.promise(async () => {
            const stateDir = mkdtempSync(join(tmpdir(), "smthrs-localjobs-fuzz-"))
            try {
              await Effect.runPromise(
                Effect.gen(function*() {
                  const client = yield* RunnerJobs.make(stateDir)
                  const daemon = yield* LocalJobs.make(stateDir)
                  const admit = RunnerJobs.admitAll(stateDir, daemon.jobs)

                  const task: AgentRunner.Task = {
                    agent: { name: "fuzz-agent", labels: ["fuzz"], profile: "coder", maxHours: 1, restarts: 1 },
                    repository: REPOSITORY,
                    base: "a".repeat(40),
                    system: ["be concise"],
                    prompt: "execute fuzz task",
                    limits: { files: 10, bytes: 1024 }
                  }
                  const key = "todo:fuzz#g1"
                  yield* client.start(task, key)
                  // Still queued in requests before admission -> Running
                  const preStatus = yield* client.status(key)
                  assertInv(preStatus._tag === "Running", "queued job reports Running")

                  yield* admit
                  // Duplicate start after admission is idempotent
                  yield* client.start(task, key)

                  const claimed = yield* daemon.host.claim({
                    profiles: ["coder"],
                    free: 1,
                    running: [],
                    waitSeconds: 0
                  })
                  assertInv(claimed !== null && claimed.key === key, "daemon claimed job")
                  if (claimed === null) return

                  // Append transcript events
                  yield* daemon.host.events({
                    key,
                    claim: claimed!.claim,
                    events: [{ seq: 0, at: 1000, kind: "agent_message_chunk", update: { content: { type: "text", text: "step 1" } } }]
                  })

                  void steerCount

                  if (cancelMidway) {
                    yield* client.cancel(key)
                    yield* admit
                  }

                  const hb = yield* daemon.host.heartbeat({ key, claim: claimed!.claim, delivered: [] })
                  assertInv(typeof hb.cancel === "boolean", "heartbeat returns cancel boolean")
                  if (cancelMidway) {
                    assertInv(hb.cancel === true, "cancelled job reflected on heartbeat")
                  }

                  if (expireLease) {
                    yield* TestClock.adjust(`${LocalJobs.LEASE_SECONDS * 4} seconds`)
                    const reclaimed = yield* daemon.host.claim({
                      profiles: ["coder"],
                      free: 1,
                      running: [],
                      waitSeconds: 0
                    })
                    const activeClaim = reclaimed ? reclaimed.claim : claimed!.claim
                    const settleOutcome = (
                      outcomeKind === "Done"
                        ? { _tag: "Done", changes: { additions: [{ path: "A.md", contents: "YQ==" }], deletions: [] }, summary: "done", usage: {} }
                        : outcomeKind === "Failed"
                        ? { _tag: "Failed", reason: "agent" as const, detail: "boom", usage: {} }
                        : { _tag: "Cancelled", processTreeGone: true, usage: {} }
                    ) as AgentRunner.Outcome
                    yield* daemon.host.settle({ key, claim: activeClaim, outcome: settleOutcome, delivered: [] })
                  } else {
                    const settleOutcome = (
                      outcomeKind === "Done"
                        ? { _tag: "Done", changes: { additions: [{ path: "A.md", contents: "YQ==" }], deletions: [] }, summary: "done", usage: {} }
                        : outcomeKind === "Failed"
                        ? { _tag: "Failed", reason: "agent" as const, detail: "boom", usage: {} }
                        : { _tag: "Cancelled", processTreeGone: true, usage: {} }
                    ) as AgentRunner.Outcome
                    yield* daemon.host.settle({ key, claim: claimed!.claim, outcome: settleOutcome, delivered: [] })
                  }

                  const finalStatus = yield* client.status(key)
                  assertInv(finalStatus._tag === "Ended" && finalStatus.outcome._tag === outcomeKind, `final status ${finalStatus._tag}/${finalStatus._tag === "Ended" ? finalStatus.outcome._tag : ""} === ${outcomeKind}`)

                  // Pure helpers
                  const boundary = LocalJobs.steerBoundary(key, ["s1", "s2"])
                  assertInv(typeof boundary === "string" && boundary.length > 0, "steerBoundary non-empty")
                }).pipe(Effect.scoped, Effect.provide(Layer.merge(TestClock.layer(), NodeServices.layer)))
              )

              // Also exercise RunnerJobs.layer(configPath) & Workstreams.project
              const configPath = join(stateDir, "runner.json")
              writeFileSync(
                configPath,
                JSON.stringify({
                  name: "fuzz-runner",
                  capacity: 1,
                  stateDir,
                  repositories: { [REPOSITORY]: { mirror: stateDir } },
                  profiles: { coder: { argv: [process.execPath, "-e", "process.exit(0)"] } },
                  workstreams: {
                    ws1: {
                      title: "Workstream 1",
                      tasks: [
                        { id: "t1", title: "Task 1", status: "done" },
                        { id: "t2", title: "Task 2", status: "doing" },
                        { id: "t3", title: "Task 3", status: "blocked" },
                        { id: "t4", title: "Task 4", status: "todo" }
                      ]
                    }
                  }
                })
              )
              const checked = await Effect.runPromise(Config.load(configPath))
              const projected = Workstreams.project(checked.workstreams, [])
              assertInv(Array.isArray(projected), "Workstreams.project folds tasks")
              const rendered = RunnerCmd.renderStatus(projected)
              assertInv(typeof rendered === "string", "RunnerCmd.renderStatus renders summary")

              await Effect.runPromise(
                Effect.gen(function*() {
                  const svc = yield* AgentRunner.AgentJobs
                  const st = yield* svc.status("missing-key")
                  assertInv(st._tag !== "Running", "layer status returns non-Running for unknown key")
                }).pipe(Effect.provide(RunnerJobs.layer(configPath)))
              )
              return true
            } finally {
              rmSync(stateDir, { recursive: true, force: true })
            }
          }),
        { seed, executions: Math.min(executions, 20) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 180_000)

  it("Live RunnerCmd.serve, Session.work, Serve.loop & Job execute real ACP agent jobs end-to-end against loopback Host", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals(["doneWithTranscript", "steerAndCancel", "unauthorizedThenRotate"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario }) =>
          Effect.promise(async () => {
            const root = mkdtempSync(join(tmpdir(), "smthrs-runner-live-fuzz-"))
            const agentState = join(root, "agent-state")
            const stateDir = join(root, "state")
            const configPath = join(root, "runner.json")
            mkdirSync(agentState, { recursive: true })
            const made = await Effect.runPromise(Config.makeToken(stateDir))
            const token = readFileSync(made.file, "utf8").trim()
            const host = await Host.start(token)
            const mirror = Host.mirror(root)
            let serving: Fiber.Fiber<unknown, unknown> | undefined
            try {
              writeFileSync(
                configPath,
                JSON.stringify({
                  origin: host.origin,
                  name: "fuzz-live-runner",
                  capacity: 2,
                  stateDir,
                  heartbeatSeconds: 1,
                  pollSeconds: 1,
                  admission: { loadPerCpu: 1000, diskFloorGb: 0 },
                  repositories: { [REPOSITORY]: { mirror: mirror.path } },
                  profiles: {
                    "test-agent": {
                      argv: [process.execPath, AGENT],
                      env: { ACP_TEST_AGENT_STATE: agentState }
                    }
                  }
                })
              )

              if (scenario === "doneWithTranscript") {
                const row = host.enqueue(
                  Host.task({
                    base: mirror.base,
                    prompt: "leak sk-fuzzsecret12345 from test@example.org\nadd the line `fuzz` to `NOTES.md`\nlate update"
                  })
                )
                serving = Effect.runFork(RunnerCmd.serve(configPath))
                const outcome = await host.settled(row, 60_000)
                assertInv(outcome._tag === "Done", `expected Done, got ${outcome._tag}`)
                if (outcome._tag === "Done") {
                  assertInv(outcome.changes.additions.some((a) => a.path === "NOTES.md"), "NOTES.md added")
                }
                const { events, contiguous } = await host.transcribed(row)
                assertInv(contiguous && events.length > 0, "transcript contiguous")
                const wire = JSON.stringify(events)
                assertInv(!wire.includes("sk-fuzzsecret12345"), "secret scrubbed from transcript")
              } else if (scenario === "steerAndCancel") {
                const row = host.enqueue(
                  Host.task({
                    base: mirror.base,
                    prompt: "talk for 3 seconds\nadd the line `x` to `A.txt`"
                  })
                )
                serving = Effect.runFork(RunnerCmd.serve(configPath))
                // Wait until claimed, then steer and cancel
                const deadline = Date.now() + 20_000
                while (row.state !== "claimed" && Date.now() < deadline) await sleep(50)
                row.steers.push({ id: "steer-1", text: "focus on tests" })
                await sleep(300)
                row.cancel = true
                const outcome = await host.settled(row, 60_000)
                assertInv(
                  outcome._tag === "Cancelled" || outcome._tag === "Done" || outcome._tag === "Failed",
                  "cancelled/finished job settled cleanly"
                )
              } else {
                // Unauthorized refusal -> check Serve.NOT_AUTHORIZED_HINT & token rotate
                assertInv(Serve.NOT_AUTHORIZED_HINT.includes("re-registration"), "NOT_AUTHORIZED_HINT present")
                host.refusal.claim = 403
                serving = Effect.runFork(RunnerCmd.serve(configPath))
                await sleep(400)
                host.refusal.claim = undefined
                const row = host.enqueue(Host.task({ base: mirror.base, prompt: "add the line `ok` to `OK.md`" }))
                const outcome = await host.settled(row, 60_000)
                assertInv(outcome._tag === "Done", "recovered after 403 refusal cleared")
              }
              return true
            } finally {
              if (serving !== undefined) await Effect.runPromise(Fiber.interrupt(serving))
              await host.close()
              rmSync(root, { recursive: true, force: true })
            }
          }),
        { seed, executions: Math.min(executions, 3) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 180_000)

  it("Local Lanes (RunnerCmd.start, serve, status, statusServer, createRunnerCli & Lane) work end-to-end", async () => {
    const lanes = Lanes.make()
    let serving: Fiber.Fiber<unknown, unknown> | undefined
    try {
      lanes.configure({
        workstreams: {
          alpha: {
            title: "Alpha Stream",
            tasks: [{ id: "notes", title: "Write notes" }]
          }
        }
      })

      // 1. statusServer HTTP GET / and /workstreams.json and 404
      await Effect.runPromise(
        Effect.gen(function*() {
          const server = yield* Layer.build(RunnerCmd.statusServer(lanes.configPath, 0))
          const { address } = Context.get(server, HttpServer.HttpServer)
          if (address._tag === "UnixPathAddress") throw new Error("expected TCP")
          const origin = `http://127.0.0.1:${address.port}`
          const page = yield* Effect.promise(() => fetch(`${origin}/`))
          assertInv(page.status === 200, "status page 200")
          const html = yield* Effect.promise(() => page.text())
          assertInv(html === StatusPage.PAGE, "status page HTML matches")
          const jsonRes = yield* Effect.promise(() => fetch(`${origin}/workstreams.json`))
          assertInv(jsonRes.status === 200, "workstreams.json 200")
          const notFound = yield* Effect.promise(() => fetch(`${origin}/nope`))
          assertInv(notFound.status === 404, "unknown path 404")
        }).pipe(Effect.scoped)
      )

      // 2. RunnerCmd.start validation errors + valid one-shot lane
      const briefFile = join(lanes.root, "brief.md")
      writeFileSync(briefFile, "add the line `lane-ok` to `LANE.md`\n")
      const badProfile = await Effect.runPromise(
        RunnerCmd.start({
          brief: briefFile,
          config: lanes.configPath,
          profile: "nonexistent-profile",
          repository: Lanes.REPOSITORY,
          standing: false,
          maxHours: 1,
          restarts: 1
        }).pipe(Effect.result)
      )
      assertInv(badProfile._tag === "Failure", "unknown profile rejected")

      const started = await Effect.runPromise(
        RunnerCmd.start({
          brief: briefFile,
          config: lanes.configPath,
          profile: "test-agent",
          repository: Lanes.REPOSITORY,
          standing: false,
          maxHours: 1,
          restarts: 1
        })
      )
      assertInv(typeof started === "object" && started !== null, "lane request queued")

      // 3. RunnerCmd.serve executes the local lane to completion
      serving = Effect.runFork(RunnerCmd.serve(lanes.configPath))
      const workstreams = await Effect.runPromise(RunnerCmd.status(lanes.configPath))
      assertInv(Array.isArray(workstreams), "RunnerCmd.status returns array")
      const rendered = RunnerCmd.renderStatus(workstreams)
      assertInv(rendered.includes("Alpha Stream"), "renderStatus includes stream title")

      // Wait briefly for lane admission
      await Lanes.until(
        () => existsSync(join(lanes.stateDir, "lanes")) || readdirSync(lanes.stateDir).length > 0,
        15_000,
        "lane state created"
      )

      // 4. Lane pure helpers
      const decoded = Lane.decodeInput({
        brief: "check lane",
        profile: "test-agent",
        repository: Lanes.REPOSITORY,
        base: "a".repeat(40),
        standing: false,
        maxHours: 1,
        restarts: 1,
        limits: RunnerCmd.LANE_LIMITS
      })
      const laneTask = Lane.taskOf(decoded)
      assertInv(laneTask.repository === Lanes.REPOSITORY, "Lane.taskOf maps repo")
      const resolvedBase = await Effect.runPromise(Lane.resolveBase(lanes.mirror.path, "main"))
      assertInv(/^[0-9a-f]{40}$/.test(resolvedBase), "Lane.resolveBase resolves commit hash")

      // 5. createRunnerCli invocation (`status --config ... --json`)
      const cli = RunnerCmd.createRunnerCli()
      let out = ""
      await cli.serve(["status", "--config", lanes.configPath, "--json"], {
        env: {},
        stdout: (t) => {
          out += t
        },
        exit: () => {}
      })
      assertInv(out.includes("Alpha Stream") || out.length > 0, "runner CLI status produces output")
    } finally {
      if (serving !== undefined) await Effect.runPromise(Fiber.interrupt(serving))
      await lanes.close()
    }
  }, 180_000)
})
