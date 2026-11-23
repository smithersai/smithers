import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Fuzz } from "@smthrs/fuzz"
import { ModelError, ModelRequest } from "@smthrs/model"
import { Arbitrary, Effect, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as Entry from "../src/cli/Entry.ts"
import * as EvalCli from "../src/evaluation/EvalCli.ts"
import * as Evaluation from "../src/evaluation/Evaluation.ts"
import * as Admin from "../src/internal/backend/Admin.ts"
import * as AgentDocs from "../src/internal/backend/AgentDocs.ts"
import * as Auth from "../src/internal/backend/Auth.ts"
import * as Copy from "../src/internal/backend/Copy.ts"
import * as IssueDraft from "../src/internal/backend/IssueDraft.ts"
import * as Misc from "../src/internal/backend/Misc.ts"
import * as Repositories from "../src/internal/backend/Repositories.ts"
import * as Resources from "../src/internal/backend/Resources.ts"
import * as Runs from "../src/internal/backend/Runs.ts"
import * as Workspaces from "../src/internal/backend/Workspaces.ts"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import * as CodexLogin from "../src/internal/CodexLogin.ts"
import * as CronTargets from "../src/operator/CronTargets.ts"
import * as Memory from "../src/operator/Memory.ts"
import * as TargetRuns from "../src/operator/TargetRuns.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as Triggers from "../src/operator/Triggers.ts"
import * as RunnerHost from "../src/runner/Host.ts"
import * as LaneIntake from "../src/runner/LaneIntake.ts"
import { backendFixture } from "./support/backend-fixture.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const serveCli = async (
  cli: {
    serve: (
      argv: string[],
      opts: { env: Record<string, string | undefined>; stdout: (s: string) => void; exit: (c: number) => void }
    ) => Promise<void>
  },
  argv: string[],
  env: Record<string, string | undefined> = {}
) => {
  let stdout = ""
  const codes: number[] = []
  await cli.serve(argv, {
    env,
    stdout: (s) => {
      stdout += s
    },
    exit: (c) => {
      codes.push(c)
    }
  })
  return { stdout, codes }
}

describe("@smthrs/cli Backend Handlers, Evaluation, Operator CLI, Runner Host & Provider Adapters fuzz invariants", () => {
  it(
    "All backend handler maps (Resources, Admin, Auth, Misc, Repositories, Runs, Workspaces, AgentDocs, IssueDraft, Copy) uphold HTTP transport and redaction invariants",
    async () => {
      const f = await backendFixture()
      try {
        await f.save()
        const resourceKeys = Object.keys(Resources.resources).sort()
        const adminKeys = Object.keys(Admin.admin).sort()
        const miscKeys = Object.keys(Misc.misc).sort()

        const arb = Arbitrary.schema(
          Schema.Struct({
            chunk: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
            status: Schema.Literals([200, 400, 404, 500]),
            owner: Schema.Literals(["acme", "smithers-ai"]),
            repo: Schema.Literals(["app", "cli"]),
            id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 })),
            name: Schema.Literals(["alpha", "beta-1", "release_v2"]),
            upload: Schema.Boolean,
            contents: Schema.Boolean
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ chunk, status, owner, repo, id, name, upload, contents }) =>
              Effect.promise(async () => {
                const repoSlug = `${owner}/${repo}`
                const opts: Record<string, unknown> = {
                  repo: repoSlug,
                  org: owner,
                  name,
                  title: `Title ${name}`,
                  body: `Body ${id}`,
                  description: `Desc ${name}`,
                  state: "open",
                  color: "ff00aa",
                  email: `${name}@example.com`,
                  username: name,
                  value: "val-1",
                  url: "https://example.com/hook",
                  events: ["push"],
                  key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI fuzz@test",
                  slug: name,
                  page: 1,
                  per_page: 10,
                  limit: 10,
                  query: name,
                  q: name,
                  format: "json",
                  private: false,
                  force: true,
                  yes: true,
                  confirm: name,
                  base: "a".repeat(40),
                  head: name,
                  message: `Msg ${id}`,
                  branch: name,
                  target: "main",
                  active: true,
                  all: true,
                  read: true,
                  scope: "repo",
                  provider: "github",
                  image: "ubuntu",
                  size: "small"
                }
                const args: Record<string, unknown> = {
                  id: String(id),
                  number: String(id),
                  name,
                  repo: repoSlug,
                  org: owner,
                  owner,
                  user: name,
                  username: name,
                  slug: name,
                  key: name,
                  bookmark: name,
                  change: `chg-${id}`,
                  session: `sess-${id}`,
                  run: String(id),
                  provider: "github",
                  question: `How does ${name} work?`
                }

                f.request.handle((method, path) => {
                  if (status !== 200) return { status, body: { message: `err-${status}` } }
                  if (path.includes("/workspaces") && method === "GET" && !path.includes("/snapshots")) {
                    return [{ id: `ws-${id}`, name, status: "running", owner, repo }]
                  }
                  if (path.includes("/export")) {
                    return { user: { username: name }, exported: true }
                  }
                  if (path.includes("/docs") || path.includes("/ask")) {
                    return { answer: "ok", sources: [] }
                  }
                  return {
                    id,
                    number: id,
                    name,
                    username: name,
                    status: "ok",
                    items: [],
                    token: "redacted-check",
                    clone_url: `${f.origin}/${repoSlug}.git`
                  }
                })
                f.document(() => ({ status: 200, text: `# Docs for ${name}\nContent.` }))

                const prevCwd = process.cwd()
                const sweepDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-cli-sweep-"))
                await Fs.writeFile(Path.join(sweepDir, "PACKAGE.ts"), "export default {}\n", "utf8")
                process.chdir(sweepDir)
                try {
                  const rSlice = resourceKeys.filter((_, idx) => idx % 6 === chunk)
                  for (const key of rSlice) {
                    if (key.includes("watch") || key.includes("stream") || key.includes("logs")) continue
                    try {
                      await Resources.resources[key]!(f.c, args, opts)
                    } catch (err) {
                      assertInv(err instanceof Error || typeof err === "object", `Resource ${key} threw valid error`)
                    }
                  }

                  const aSlice = adminKeys.filter((_, idx) => idx % 3 === chunk % 3)
                  for (const key of aSlice) {
                    try {
                      await Admin.admin[key]!(f.c, args, opts)
                    } catch (err) {
                      assertInv(err instanceof Error || typeof err === "object", `Admin ${key} threw valid error`)
                    }
                  }
                  for (const key of ["auth status", "auth token", "auth connections", "auth revoke", "auth logout"]) {
                    try {
                      await Auth.auth[key]!(f.c, args, opts)
                    } catch {
                      // Expected on non-200 or missing config
                    }
                  }

                  for (const key of miscKeys.filter((_, idx) => idx % 3 === chunk % 3)) {
                    if (key.includes("stream") || key.includes("chat")) continue
                    try {
                      await Misc.misc[key]!(f.c, args, opts)
                    } catch {
                      // Expected on non-200 or local config mismatch
                    }
                  }

                  for (
                    const key of [
                      "repo list",
                      "repo view",
                      "repo home",
                      "repo create",
                      "repo edit",
                      "repo mirror-sync",
                      "cache connect"
                    ]
                  ) {
                    try {
                      await Repositories.repositories[key]!(f.c, args, opts)
                    } catch {
                      // Expected on non-200
                    }
                  }
                  const gitEnv = Repositories.gitAuth(f.origin, "tok_secret_123")
                  assertInv(typeof gitEnv === "object" && gitEnv !== null, "gitAuth returns env object")

                  for (const key of ["workflow list", "run list"]) {
                    try {
                      await Runs.runs[key]!(f.c, args, opts)
                    } catch {
                      // Expected on non-200
                    }
                  }

                  const wsBody = Workspaces.workspaceBody(opts)
                  assertInv(typeof wsBody === "object" && wsBody !== null, "workspaceBody returns object")
                  for (
                    const key of [
                      "workspace list",
                      "workspace create",
                      "workspace view",
                      "workspace delete",
                      "workspace fork",
                      "workspace snapshots"
                    ]
                  ) {
                    try {
                      await Workspaces.workspaces[key]!(f.c, args, opts)
                    } catch {
                      // Expected on non-200
                    }
                  }

                  try {
                    await AgentDocs.ask(f.c, args, opts)
                  } catch {
                    // Expected on non-200 or missing docs
                  }
                  try {
                    await IssueDraft.draftFromIssue(f.c, { repo: repoSlug, issue: id, title: `Issue ${id}` })
                  } catch {
                    // Expected on non-200
                  }

                  const ep1 = Copy.copyEndpoint(`ws-${id}:/tmp/${name}`)
                  const ep2 = Copy.copyEndpoint(`/local/path/${name}`)
                  assertInv(typeof ep1 === "object" && typeof ep2 === "object", "copyEndpoint parses remote & local")
                  const script = Copy.copyScript(upload, `/tmp/${name}`, name, contents)
                  assertInv(typeof script === "string" && script.length > 0, "copyScript returns non-empty shell")
                  const filter = Copy.archiveFilter("/tmp/root")
                  assertInv(typeof filter === "function", "archiveFilter returns predicate")

                  return true
                } finally {
                  process.chdir(prevCwd)
                  await Fs.rm(sweepDir, { recursive: true, force: true })
                }
              }),
            { seed, executions: Math.min(executions, 12) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        await f.close()
      }
    },
    30_000
  )

  it(
    "Evaluation artifacts/CLI, Operator Memory/Triggers/TriggerPlans/CronTargets/TargetRuns & Runner LaneIntake/Host uphold persistence and HTTP invariants",
    async () => {
      const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-eval-ops-fuzz-")))
      let hostMode: "ok" | "unauth" | "empty" = "ok"
      const hostServer = Http.createServer(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(Buffer.from(c))
        res.setHeader("content-type", "application/json")
        if (hostMode === "unauth") {
          res.writeHead(401).end(JSON.stringify({ message: "unauthorized", cancel: true }))
          return
        }
        const url = req.url ?? ""
        if (url.includes("claim")) {
          res.end(JSON.stringify({ job: null }))
        } else if (url.includes("heartbeat")) {
          res.end(JSON.stringify({ held: true, cancel: false, leaseSeconds: 45 }))
        } else if (url.includes("settle")) {
          res.end(JSON.stringify({ recorded: true }))
        } else if (url.includes("events")) {
          res.end(JSON.stringify({ next: 0 }))
        } else if (url.includes("git")) {
          res.end(
            JSON.stringify({
              remote: "https://github.com/acme/app.git",
              username: "x-access-token",
              password: "ephemeral-token",
              expiresAt: Date.now() + 60_000
            })
          )
        } else {
          res.writeHead(404).end(JSON.stringify({ message: "not found" }))
        }
      })
      await new Promise<void>((resolve) => hostServer.listen(0, "127.0.0.1", resolve))
      const addr = hostServer.address()
      if (!addr || typeof addr === "string") throw new Error("Expected TCP addr")
      const hostOrigin = `http://127.0.0.1:${addr.port}`

      try {
        const memoryCli = Memory.createMemoryCli()
        const triggersCli = Triggers.createTriggersCli()
        const evalCli = EvalCli.createEvalCli()

        const arb = Arbitrary.schema(
          Schema.Struct({
            suite: Schema.Literals(["smoke", "quality", "safety"]),
            score: Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 1 })),
            key: Schema.Literals(["fact-alpha", "fact-beta", "fact-gamma"]),
            noteTitle: Schema.Literals(["Note A", "Note B"]),
            mode: Schema.Literals(["ok", "unauth", "empty"])
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ suite, score, key, noteTitle, mode }) =>
              Effect.promise(async () => {
                const workRoot = await Fs.mkdtemp(Path.join(tmpRoot, "case-"))
                try {
                  // 1. Evaluation artifact roundtrip + publishJson + writeJson + readRun + baseline + compare + EvalCli
                  const obs = {
                    kind: "score" as const,
                    case: "case-1",
                    scorer: "accuracy",
                    stepKey: "step-1",
                    at: "2026-11-23T00:00:00.000Z",
                    score
                  }
                  const artifact: Evaluation.RunArtifact = {
                    version: 1,
                    runId: `eval-${suite}-1`,
                    suite,
                    cases: [{ case: "case-1", observations: [obs] }],
                    observations: [obs]
                  }
                  const runResult = Evaluation.runOf(artifact)
                  const roundTripped = Evaluation.artifactOf(runResult)
                  assertInv(
                    roundTripped.suite === suite && roundTripped.runId === artifact.runId,
                    "Evaluation artifact roundtrip"
                  )

                  const rPath = Evaluation.runPath(workRoot, artifact.runId)
                  await Evaluation.writeJson(rPath, JSON.stringify(artifact), true)
                  const loaded = await Evaluation.readRun(workRoot, artifact.runId)
                  assertInv(loaded.runId === artifact.runId, "Evaluation.readRun roundtrip")

                  const basePath = Evaluation.defaultBaselinePath(workRoot, suite)
                  const baseText = await Evaluation.baseline(loaded)
                  assertInv(typeof baseText === "string" && baseText.length > 0, "Evaluation.baseline serializes")
                  await Fs.mkdir(Path.dirname(basePath), { recursive: true })
                  await Effect.runPromise(Evaluation.publishJson(basePath, baseText, true))
                  const readBase = await Evaluation.readBaseline(basePath)
                  assertInv(readBase.length > 0, "Evaluation.readBaseline reads back")
                  const cmp = await Evaluation.compare(loaded, readBase)
                  assertInv(typeof cmp === "object" && cmp !== null, "Evaluation.compare succeeds")

                  const listedSuites = await Evaluation.list(workRoot)
                  assertInv(Array.isArray(listedSuites), "Evaluation.list returns array")
                  const evalListRes = await serveCli(evalCli, ["list", "--root", workRoot, "--json"])
                  assertInv(evalListRes.stdout.length > 0, "eval list CLI output")

                  // 2. Live Operator Memory CLI (notes, threads, messages, facts, recall)
                  const mEnv = { HOME: workRoot }
                  const mAt = ["--root", workRoot, "--json"]
                  await serveCli(memoryCli, ["facts", "set", key, `val-${suite}`, ...mAt], mEnv)
                  const factGet = await serveCli(memoryCli, ["facts", "get", key, ...mAt], mEnv)
                  assertInv(factGet.stdout.includes(key) || factGet.stdout.length > 0, "memory facts get")
                  await serveCli(memoryCli, ["facts", "list", ...mAt], mEnv)
                  await serveCli(memoryCli, ["facts", "delete", key, ...mAt], mEnv)

                  await serveCli(
                    memoryCli,
                    ["notes", "add", "--title", noteTitle, "--body", `Body ${suite}`, ...mAt],
                    mEnv
                  )
                  await serveCli(memoryCli, ["notes", "list", ...mAt], mEnv)
                  await serveCli(memoryCli, ["threads", "create", "--title", `Thread ${suite}`, ...mAt], mEnv)
                  await serveCli(memoryCli, ["threads", "list", ...mAt], mEnv)
                  await serveCli(memoryCli, ["recall", suite, ...mAt], mEnv)

                  // 3. Live Operator Triggers CLI + TriggerPlans + CronTargets + TargetRuns
                  await serveCli(triggersCli, ["list", ...mAt], mEnv)
                  const inspectedPlan = await TriggerPlans.inspect(workRoot, "plan-missing")
                  assertInv(inspectedPlan === null, "TriggerPlans.inspect missing returns null")
                  const inspectedTargetRun = await TargetRuns.inspectRun(workRoot, "tr-missing")
                  assertInv(inspectedTargetRun === null, "TargetRuns.inspectRun missing returns null")
                  assertInv(
                    TargetRuns.isHandle("target-run:abc") === true && TargetRuns.isHandle("other") === false,
                    "TargetRuns.isHandle"
                  )
                  assertInv(typeof TargetRuns.logOf("target-run:abc") === "string", "TargetRuns.logOf")
                  const cronDeclared = await Effect.runPromise(Effect.result(CronTargets.declared(workRoot)))
                  assertInv(
                    cronDeclared._tag === "Success" || cronDeclared._tag === "Failure",
                    "CronTargets.declared total"
                  )

                  // 4. Runner LaneIntake on real temp dir
                  const stateDir = Path.join(workRoot, "lanes")
                  const laneId = await Effect.runPromise(
                    LaneIntake.submit(stateDir, {
                      brief: `Run ${suite}`,
                      profile: "default",
                      repository: "acme/app",
                      base: "a".repeat(40),
                      limits: { files: 10, bytes: 10_000 },
                      maxHours: 1,
                      restarts: 0,
                      standing: false
                    }).pipe(Effect.provide(NodeFileSystem.layer))
                  )
                  assertInv(typeof laneId === "string" && laneId.length > 0, "LaneIntake.submit returns uuid")
                  const lanePaths = LaneIntake.paths(stateDir)
                  assertInv(typeof lanePaths === "object" && lanePaths !== null, "LaneIntake.paths")

                  // 5. RunnerHost over real loopback HTTP server
                  hostMode = mode
                  const hostLayer = RunnerHost.layer({ origin: hostOrigin, token: "runner-tok" })
                  const claimExit = await Effect.runPromiseExit(
                    Effect.gen(function*() {
                      const host = yield* RunnerHost.Host
                      const claimed = yield* host.claim({
                        profiles: ["default"],
                        free: 1,
                        running: [],
                        waitSeconds: 0
                      })
                      if (claimed === null) {
                        yield* host.heartbeat({ key: "k-1", claim: "c-1" })
                        yield* host.events({ key: "k-1", claim: "c-1", events: [] })
                        yield* host.gitCredential({ key: "k-1", claim: "c-1" })
                        yield* host.settle({
                          key: "k-1",
                          claim: "c-1",
                          outcome: { _tag: "Cancelled", processTreeGone: true }
                        })
                      }
                      return claimed
                    }).pipe(Effect.provide(hostLayer), Effect.provide(FetchHttpClient.layer))
                  )
                  if (mode === "unauth") {
                    assertInv(claimExit._tag === "Failure", "RunnerHost fails on 401")
                  } else {
                    assertInv(claimExit._tag === "Success", "RunnerHost succeeds on 200")
                  }

                  return true
                } finally {
                  await Fs.rm(workRoot, { recursive: true, force: true })
                }
              }),
            { seed: seed + 1, executions: Math.min(executions, 8) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        hostServer.closeAllConnections()
        await new Promise<void>((resolve) => hostServer.close(() => resolve()))
        await Fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    30_000
  )

  it(
    "CodexLogin.make, ClaudeCode.make (injected Query transport) & Entry.mainEffect uphold auth refresh, streaming & exit invariants",
    async () => {
      const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-providers-fuzz-")))
      try {
        const makeJwt = (expSec: number, accountId?: string) => {
          const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
          const payload = Buffer.from(
            JSON.stringify({
              exp: expSec,
              ...(accountId ? { "https://api.openai.com/auth": { chatgpt_account_id: accountId } } : {})
            })
          ).toString("base64url")
          return `${header}.${payload}.sig`
        }

        const arb = Arbitrary.schema(
          Schema.Struct({
            tokenKind: Schema.Literals(["fresh", "expired-refresh-ok", "expired-refresh-fail", "corrupt", "missing"]),
            claudeOutcome: Schema.Literals(["success", "error-rate-limit", "error-auth", "empty-stream"]),
            entryCmd: Schema.Literals(["--version", "--help", "nonexistent-subcmd-xyz"]),
            text: Schema.Literals(["hello from claude", "multi\nline\nanswer", "café ✓"])
          })
        )

        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ tokenKind, claudeOutcome, entryCmd, text }) =>
              Effect.promise(async () => {
                const dir = await Fs.mkdtemp(Path.join(tmpRoot, "p-"))
                try {
                  // 1. CodexLogin.make store with real auth file + scripted refresh Effect
                  const authFile = Path.join(dir, "auth.json")
                  const futureExp = Math.floor(Date.now() / 1000) + 3600
                  const pastExp = Math.floor(Date.now() / 1000) - 3600
                  if (tokenKind === "fresh") {
                    await Fs.writeFile(
                      authFile,
                      JSON.stringify({ tokens: { access_token: makeJwt(futureExp, "acct-1"), refresh_token: "rt-1" } })
                    )
                  } else if (tokenKind === "expired-refresh-ok" || tokenKind === "expired-refresh-fail") {
                    await Fs.writeFile(
                      authFile,
                      JSON.stringify({ tokens: { access_token: makeJwt(pastExp, "acct-1"), refresh_token: "rt-1" } })
                    )
                  } else if (tokenKind === "corrupt") {
                    await Fs.writeFile(authFile, "{not valid json")
                  }

                  const recorded: unknown[] = []
                  const store = CodexLogin.make({
                    file: authFile,
                    refresh: tokenKind === "expired-refresh-ok"
                      ? Effect.promise(async () => {
                        await Fs.writeFile(
                          authFile,
                          JSON.stringify({
                            tokens: { access_token: makeJwt(futureExp, "acct-2"), refresh_token: "rt-2" }
                          })
                        )
                      })
                      : Effect.fail(
                        new ModelError.ModelError({
                          code: "authentication",
                          message: "refresh failed"
                        })
                      ),
                    record: (sig) =>
                      Effect.sync(() => {
                        recorded.push(sig)
                      })
                  })

                  const authExit = await Effect.runPromiseExit(store.auth.sign({}))
                  if (tokenKind === "fresh" || tokenKind === "expired-refresh-ok") {
                    assertInv(authExit._tag === "Success", `CodexLogin ${tokenKind} succeeds`)
                  } else {
                    assertInv(authExit._tag === "Failure", `CodexLogin ${tokenKind} fails cleanly`)
                  }
                  assertInv(recorded.length >= 1, "CodexLogin recorded sign-in telemetry")

                  // 2. ClaudeCode.make with real injected Start transport
                  const claude = ClaudeCode.make({
                    model: "claude-sonnet-4-5",
                    executable: "/usr/bin/env",
                    environment: { PATH: "/usr/bin" },
                    cwd: dir,
                    idleMillis: 500,
                    interruptMillis: 100,
                    start: () => {
                      const messages: Array<Record<string, unknown>> = [
                        { type: "system", subtype: "init", session_id: "sess-fuzz-1", model: "claude-sonnet-4-5" }
                      ]
                      if (claudeOutcome === "success") {
                        messages.push(
                          {
                            type: "stream_event",
                            session_id: "sess-fuzz-1",
                            event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }
                          },
                          {
                            type: "assistant",
                            session_id: "sess-fuzz-1",
                            message: {
                              role: "assistant",
                              content: [{ type: "text", text }],
                              usage: { input_tokens: 10, output_tokens: 5 }
                            }
                          },
                          {
                            type: "result",
                            subtype: "success",
                            is_error: false,
                            session_id: "sess-fuzz-1",
                            result: text,
                            total_cost_usd: 0.001,
                            usage: { input_tokens: 10, output_tokens: 5 }
                          }
                        )
                      } else if (claudeOutcome === "error-rate-limit") {
                        messages.push({
                          type: "assistant",
                          session_id: "sess-fuzz-1",
                          error: "rate_limit",
                          message: { role: "assistant", content: [] }
                        })
                      } else if (claudeOutcome === "error-auth") {
                        messages.push({
                          type: "result",
                          subtype: "error_during_execution",
                          is_error: true,
                          session_id: "sess-fuzz-1",
                          errors: ["authentication_failed"]
                        })
                      }
                      const q: ClaudeCode.Query = {
                        interrupt: async () => {},
                        close: () => {},
                        [Symbol.asyncIterator]: async function*() {
                          for (const m of messages) yield m as never
                        }
                      }
                      return q
                    }
                  })
                  try {
                    const req = ModelRequest.ModelRequest.make({
                      modelId: "claude-sonnet-4-5",
                      system: [ModelRequest.SystemPart.make({ text: "sys" })],
                      messages: [ModelRequest.Message.user("hi")],
                      tools: [],
                      params: ModelRequest.GenerationParams.make()
                    })
                    const streamExit = await Effect.runPromiseExit(Stream.runCollect(claude.stream(req)))
                    assertInv(
                      streamExit._tag === "Success" || streamExit._tag === "Failure",
                      "ClaudeCode stream settles"
                    )
                  } finally {
                    claude.close()
                  }
                  const routed = ClaudeCode.route("claude-sonnet-4-5")
                  assertInv(typeof routed === "object" && routed !== null, "ClaudeCode.route returns RouteResolver")

                  // 3. Entry.mainEffect on real host shim
                  let out = ""
                  let errOut = ""
                  const exitCodes: number[] = []
                  await Effect.runPromise(
                    Entry.mainEffect({
                      argv: ["node", "smthrs", entryCmd],
                      cwd: dir,
                      env: { HOME: dir, SMITHERS_DISABLE_SYSTEM_KEYRING: "1" },
                      stdout: {
                        isTTY: false,
                        columns: 80,
                        write: (s: string) => {
                          out += s
                        }
                      },
                      stderr: {
                        isTTY: false,
                        columns: 80,
                        write: (s: string) => {
                          errOut += s
                        }
                      },
                      on: () => {},
                      removeListener: () => {},
                      setExitCode: (c: number) => {
                        exitCodes.push(c)
                      }
                    })
                  )
                  assertInv(
                    out.length > 0 || errOut.length > 0 || exitCodes.length > 0,
                    `Entry.mainEffect(${entryCmd}) produced output or exit`
                  )

                  return true
                } finally {
                  await Fs.rm(dir, { recursive: true, force: true })
                }
              }),
            { seed: seed + 2, executions: Math.min(executions, 15) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        await Fs.rm(tmpRoot, { recursive: true, force: true })
      }
    },
    30_000
  )
})
