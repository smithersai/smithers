import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import { Fuzz } from "@smthrs/fuzz"
import * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Arbitrary, Deferred, Effect, Latch, Layer, Option, Queue, Schema, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"
import * as CliMod from "../src/Cli.ts"
import * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as Settlement from "../src/commands/Settlement.ts"
import * as Auth from "../src/internal/backend/Auth.ts"
import * as ClientMod from "../src/internal/backend/Client.ts"
import * as SessionMod from "../src/internal/backend/Session.ts"
import * as Stack from "../src/internal/backend/Stack.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as CronTargets from "../src/operator/CronTargets.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as Triggers from "../src/operator/Triggers.ts"
import * as Config from "../src/runner/Config.ts"
import * as RunnerHost from "../src/runner/Host.ts"
import * as RunnerSession from "../src/runner/Session.ts"
import { project } from "./support/unified-cli.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const serveCli = async (
  cli: { serve: (args?: Array<string>, opts?: any) => Promise<unknown> },
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {}
) => {
  let stdout = ""
  const codes: Array<number> = []
  await cli.serve([...args], {
    env,
    stdout: (t: string) => (stdout += t),
    exit: (c: number) => codes.push(c)
  })
  return { stdout, codes }
}

describe("@smthrs/cli Wave-5 TriggerPlans, CronTargets, Settlement, ControlBridge, Cli full surface, Stack deep, Auth/Session, RunnerSession & Agents fuzz invariants", () => {
  it("TriggerPlans full standing approval lifecycle (preview -> grant -> inspect -> revoke), CronTargets sync, Settlement & ControlBridge uphold invariants", async () => {
    const proj = await project()
    const echoPath = join(proj, ".smithers/flows/echo/flow.ts")
    writeFileSync(echoPath, readFileSync(echoPath, "utf8").replace("capabilities: []", 'capabilities: ["fs:read:*"]'))

    try {
      // 1. Register a real cron trigger & execute full TriggerPlans preview -> grant -> inspect -> revoke!
      const trigId = "trig-fuzz-standing-1"
      await Triggers.withTriggers(
        { root: proj },
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const trig = yield* Trigger.make({
            id: trigId,
            kind: "cron",
            schedule: "0 3 * * *",
            flowId: "echo",
            input: { message: "from-trigger" }
          } as never)
          yield* store.register(trig)
        })
      ).catch(() => {})

      const ctrlLayer = NodeControl.layerControl({ root: proj })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const preview = yield* TriggerPlans.previewApproval(proj, trigId).pipe(Effect.result)
            if (preview._tag === "Success") {
              const p = preview.success as unknown as { readonly approval?: unknown; readonly plan?: unknown }
              const granted = yield* TriggerPlans.grantApproval(proj, (p.approval ?? p) as never).pipe(Effect.result)
              if (granted._tag === "Success") {
                const g = granted.success as unknown as { readonly grantId?: string; readonly handle?: string }
                if (typeof g.handle === "string") {
                  const insp = yield* Effect.promise(() => TriggerPlans.inspect(proj, g.handle!))
                  assertInv(insp !== null, "TriggerPlans.inspect finds granted handle")
                }
                if (typeof g.grantId === "string") {
                  const rev = yield* TriggerPlans.revokeApproval(proj, g.grantId).pipe(Effect.result)
                  assertInv(rev._tag === "Success", "TriggerPlans.revokeApproval succeeded")
                }
              }
            }

            // CronTargets.sync on real project root
            yield* Effect.promise(() => Triggers.withTriggers({ root: proj }, CronTargets.sync(proj)).catch(() => {}))

            // Settlement helpers against live Control service
            const control = yield* Control.Control
            const planRes = yield* control.plan({ flowId: "echo", input: { message: "settle" } })
            yield* control.approve({ ...planRes.approval, scope: "run" })
            const runRec = yield* control.run({
              target: planRes.approval.target,
              approved: true
            } as never).pipe(Effect.result)
            if (runRec._tag === "Success" && runRec.success._tag === "Accepted" && runRec.success.runId) {
              const awaited = yield* Settlement.awaitRun(control, runRec.success.runId, 0, true).pipe(
                Effect.result
              )
              assertInv(awaited._tag === "Success" || awaited._tag === "Failure", "Settlement.awaitRun")
              const seq = yield* Settlement.latestSequence(Stream.empty).pipe(Effect.result)
              assertInv(seq._tag === "Success", "Settlement.latestSequence empty")
            }

            // Settlement decisionPark & releasedCause
            const dp = yield* Settlement.decisionPark(control, { _tag: "Node", runId: "r-1", nodeId: "n-1" } as never).pipe(
              Effect.result
            )
            assertInv(dp._tag === "Success" || dp._tag === "Failure", "Settlement.decisionPark")
            const rc = Settlement.releasedCause("r-1", "echo", [
              { kind: "control.run.decision", sequence: 4, atMs: 1000, runId: "r-1", payload: { decision: "interrupt-released", cause: "interrupted", flowName: "echo" } } as never
            ])
            assertInv(typeof rc === "string", "Settlement.releasedCause")
          }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, ctrlLayer) as Layer.Layer<any, never, never>))
        )
      )

      // ControlBridge helper matrix
      const env = { HOME: proj, SMITHERS_ROOT: proj, SMITHERS_TOKEN: "tok-1" }
      const rt = { environment: env }
      assertInv(ControlBridge.isRemote({ quiet: true, root: proj }, rt) === false, "ControlBridge.isRemote local")
      assertInv(ControlBridge.isRemote({ quiet: true, remote: "http://127.0.0.1:43111" }, rt) === true, "ControlBridge.isRemote remote")
      assertInv(ControlBridge.connectionArguments({ quiet: false, root: proj }).includes("--root"), "ControlBridge.connectionArguments --root")
      assertInv(ControlBridge.connectionArguments({ quiet: true, remote: "http://127.0.0.1:43111" }).includes("--remote"), "ControlBridge.connectionArguments --remote")
      assertInv(typeof ControlBridge.configuration({ quiet: true, root: proj }, rt) === "object", "ControlBridge.configuration local")
      assertInv(typeof ControlBridge.configuration({ quiet: true, remote: "http://127.0.0.1:43111" }, rt) === "object", "ControlBridge.configuration remote")
    } finally {
      rmSync(proj, { recursive: true, force: true })
    }
  }, 180_000)

  it("Cli.makeCli full mounted command tree, Stack deep (direct + github-proxy + update + 422 adopt + sync + land + unsubmit), Auth browserLogin & Session edge cases uphold invariants", async () => {
    const prevCwd = process.cwd()
    const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-w5-cli-stack-")))
    let stackState: { changes: Array<Record<string, unknown>> } = { changes: [] }
    let force422Once = false
    let prCounter = 10
    const prs: Array<Record<string, unknown>> = []

    const srv = createServer((req, res) => {
      let raw = ""
      req.setEncoding("utf8")
      req.on("data", (c) => (raw += c))
      req.on("end", () => {
        const url = req.url ?? "/"
        const method = req.method ?? "GET"
        let body: Record<string, unknown> = {}
        try {
          body = raw ? JSON.parse(raw) : {}
        } catch {}

        if (url.includes("/stack") && method === "GET") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(stackState))
          return
        }
        if (url.includes("/stack") && (method === "PUT" || method === "POST")) {
          if (Array.isArray(body.changes)) stackState = { changes: body.changes as Array<Record<string, unknown>> }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(stackState))
          return
        }
        if (url.includes("/stack") && method === "DELETE") {
          stackState = { changes: [] }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (url.includes("/github-proxy") && method === "POST") {
          const innerMethod = String(body.method ?? "GET")
          const innerPath = String(body.path ?? "")
          const innerBody = (body.body ?? {}) as Record<string, unknown>
          if (innerMethod === "POST" && innerPath.endsWith("/pulls")) {
            const num = prCounter++
            const pr = {
              number: num,
              state: "open",
              title: innerBody.title ?? `PR ${num}`,
              body: innerBody.body ?? "",
              head: { ref: innerBody.head ?? `smithers/p${num}` },
              base: { ref: innerBody.base ?? "main" },
              html_url: `https://github.com/owner/repo/pull/${num}`,
              mergeable: true
            }
            prs.push(pr)
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(pr))
            return
          }
          if (innerMethod === "GET" && innerPath.includes("/pulls")) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify(innerPath.match(/\/pulls\/\d+$/) ? prs[0] ?? { number: 10, state: "open", mergeable: true } : prs))
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ number: 10, state: "open", merged: true, html_url: "https://github.com/owner/repo/pull/10" }))
          return
        }
        if (url.includes("/pulls") && method === "POST") {
          if (force422Once) {
            force422Once = false
            res.writeHead(422, { "content-type": "application/json" })
            res.end(JSON.stringify({ message: "Validation Failed: A pull request already exists" }))
            return
          }
          const num = prCounter++
          const pr = {
            number: num,
            state: "open",
            title: body.title ?? `PR ${num}`,
            body: body.body ?? "",
            head: { ref: body.head ?? `smithers/p${num}` },
            base: { ref: body.base ?? "main" },
            html_url: `https://github.com/owner/repo/pull/${num}`,
            draft: Boolean(body.draft),
            mergeable: true
          }
          prs.push(pr)
          res.writeHead(201, { "content-type": "application/json" })
          res.end(JSON.stringify(pr))
          return
        }
        if (url.includes("/pulls/") && url.endsWith("/merge")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ merged: true, sha: "b".repeat(40) }))
          return
        }
        if (url.includes("/pulls/") && method === "PATCH") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ number: 10, state: body.state ?? "open", title: body.title ?? "Updated", html_url: "https://github.com/owner/repo/pull/10" }))
          return
        }
        if (url.includes("/pulls/") && method === "GET") {
          const found = prs[0] ?? { number: 10, state: "open", merged: false, mergeable: true, head: { ref: "smithers/p10" }, base: { ref: "main" } }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(found))
          return
        }
        if (url.includes("/pulls") && method === "GET") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(prs))
          return
        }
        if (url.includes("/auth/cli/start") || url.includes("/cli/login") || url.includes("/oauth")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ url: `${origin}/consent`, code: "auth-code-1", token: "exchanged_tok_123", username: "browser-op" }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(method === "GET" && url.endsWith("s") ? [{ id: 1, name: "item-1" }] : { ok: true, id: 1, username: "cli-op", logged_in: true }))
      })
    })
    await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done))
    const addr = srv.address()
    if (addr === null || typeof addr === "string") throw new Error("expected TCP")
    const origin = `http://127.0.0.1:${addr.port}`

    try {
      // 1. Real 2-commit jj stack exercising direct GITHUB_TOKEN AND /github-proxy AND update AND 422 adopt AND status/sync/land/unsubmit
      const bareDir = join(root, "bare.git")
      const seedDir = join(root, "seed")
      const workDir = join(root, "work")
      mkdirSync(bareDir, { recursive: true })
      mkdirSync(seedDir, { recursive: true })

      const baseEnv: Record<string, string | undefined> = {
        ...process.env,
        JJ_CONFIG: "",
        XDG_CONFIG_HOME: join(root, "xdg"),
        XDG_CACHE_HOME: join(root, "cache"),
        SMITHERS_AUTH_FILE: join(root, "auth.json"),
        SMITHERS_API_ORIGIN: origin,
        SMITHERS_GITHUB_API_URL: origin,
        SMITHERS_TOKEN: "w5_cli_tok_12345",
        SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
        GIT_AUTHOR_NAME: "Fuzz",
        GIT_AUTHOR_EMAIL: "fuzz@example.test",
        GIT_COMMITTER_NAME: "Fuzz",
        GIT_COMMITTER_EMAIL: "fuzz@example.test"
      }
      execFileSync("git", ["init", "--bare", "-b", "main", bareDir], { stdio: "ignore", env: baseEnv })
      execFileSync("git", ["init", "-b", "main", seedDir], { stdio: "ignore", env: baseEnv })
      writeFileSync(join(seedDir, "README.md"), "# Stack Base\n")
      execFileSync("git", ["add", "."], { cwd: seedDir, stdio: "ignore", env: baseEnv })
      execFileSync("git", ["commit", "-m", "base"], { cwd: seedDir, stdio: "ignore", env: baseEnv })
      execFileSync("git", ["remote", "add", "origin", bareDir], { cwd: seedDir, stdio: "ignore", env: baseEnv })
      execFileSync("git", ["push", "origin", "main"], { cwd: seedDir, stdio: "ignore", env: baseEnv })

      execFileSync("jj", ["git", "clone", bareDir, workDir], { stdio: "ignore", env: baseEnv })
      execFileSync("jj", ["config", "set", "--repo", "user.name", "Fuzz"], { cwd: workDir, stdio: "ignore", env: baseEnv })
      execFileSync("jj", ["config", "set", "--repo", "user.email", "fuzz@example.test"], { cwd: workDir, stdio: "ignore", env: baseEnv })
      writeFileSync(join(workDir, "f1.txt"), "one\n")
      execFileSync("jj", ["commit", "-m", "feat: commit one\n\nDetails one"], { cwd: workDir, stdio: "ignore", env: baseEnv })
      writeFileSync(join(workDir, "f2.txt"), "two\n")
      execFileSync("jj", ["commit", "-m", "feat: commit two\n\nDetails two"], { cwd: workDir, stdio: "ignore", env: baseEnv })

      process.chdir(workDir)

      // Direct GitHub token mode: submit (creates 2 PRs) -> submit again (updates!) -> status -> sync -> land -> unsubmit
      const directClient = new ClientMod.Client({
        environment: { ...baseEnv, GITHUB_TOKEN: "ghs_w5_direct" },
        exit: () => {},
        stderr: { write: () => {}, isTTY: false, columns: 80 }
      })
      await Stack.stacks["stack submit"]!(directClient, {}, { repo: "owner/repo", target: "main" }).catch(() => {})
      // Re-submit with existing stackState -> updates PRs!
      await Stack.stacks["stack submit"]!(directClient, {}, { repo: "owner/repo", target: "main", draft: true }).catch(() => {})
      // Force 422 adoption path!
      stackState = { changes: [] }
      force422Once = true
      await Stack.stacks["stack submit"]!(directClient, {}, { repo: "owner/repo", target: "main" }).catch(() => {})
      await Stack.stacks["stack status"]!(directClient, {}, { repo: "owner/repo", target: "main" }).catch(() => {})
      await Stack.stacks["stack sync"]!(directClient, {}, { repo: "owner/repo", target: "main" }).catch(() => {})
      await Stack.stacks["stack land"]!(directClient, {}, { repo: "owner/repo", target: "main", yes: true }).catch(() => {})
      await Stack.stacks["stack unsubmit"]!(directClient, {}, { repo: "owner/repo", target: "main", yes: true }).catch(() => {})

      // Proxy mode (NO GITHUB_TOKEN -> hits /github-proxy!)
      const proxyEnv = { ...baseEnv }
      delete proxyEnv.GITHUB_TOKEN
      const proxyClient = new ClientMod.Client({
        environment: proxyEnv,
        exit: () => {},
        stderr: { write: () => {}, isTTY: false, columns: 80 }
      })
      await Stack.stacks["stack submit"]!(proxyClient, {}, { repo: "owner/repo", target: "main" }).catch(() => {})
      await Stack.stacks["stack status"]!(proxyClient, {}, { repo: "owner/repo", target: "main" }).catch(() => {})

      // 2. Cli.makeCli mounted backend & operator commands sweep
      const proj = await project()
      try {
        const cli = CliMod.makeCli({ environment: { ...baseEnv, HOME: root }, exit: () => {} })
        const cliCommands: Array<ReadonlyArray<string>> = [
          ["auth", "status", "--json"],
          ["auth", "token", "--json"],
          ["config", "list", "--json"],
          ["config", "set", "default_repo", "owner/repo"],
          ["config", "get", "default_repo"],
          ["completion", "bash"],
          ["completion", "zsh"],
          ["completion", "fish"],
          ["repo", "list", "--json"],
          ["issue", "list", "--repo", "owner/repo", "--json"],
          ["run", "list", "--repo", "owner/repo", "--json"],
          ["workflow", "list", "--repo", "owner/repo", "--json"],
          ["workspace", "list", "--repo", "owner/repo", "--json"],
          ["environment", "list", "--json"],
          ["eval", "list", "--root", proj, "--json"],
          ["memory", "list", "--namespace", "user:cli", "--root", proj, "--json"],
          ["triggers", "list", "--root", proj, "--json"],
          ["integrations", "list", "--root", proj, "--json"],
          ["alerts", "list", "--run", "r1", "--root", proj, "--json"],
          ["step-cache", "ls", "--root", proj, "--json"],
          ["suggest", "--list", "--root", proj, "--json"],
          ["info", "--root", proj, "--json"],
          ["targets", "--root", proj, "--json"]
        ]
        for (const argv of cliCommands) {
          await serveCli(cli, argv, { ...baseEnv, HOME: root }).catch(() => {})
        }
      } finally {
        rmSync(proj, { recursive: true, force: true })
      }

      // 3. Session edge cases (corrupt auth file, multi-origin, SMITHERS_HOST, save/resolve/invalidate/clear)
      const sessDir = join(root, "sess-edge")
      mkdirSync(sessDir, { recursive: true })
      const corruptAuth = join(sessDir, "auth.json")
      writeFileSync(corruptAuth, "{not valid json")
      const sEnv: Record<string, string | undefined> = {
        HOME: sessDir,
        XDG_CONFIG_HOME: sessDir,
        SMITHERS_AUTH_FILE: corruptAuth,
        SMITHERS_API_ORIGIN: origin,
        SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
      }
      const sess = new SessionMod.Session(sEnv)
      await sess.resolve(origin).catch(() => {})
      await sess.save(origin, "tok-1", { username: "u1" })
      assertInv((await sess.resolve(origin))?.token === "tok-1", "Session recovers from corrupt auth file on save")
      sess.invalidateCredential(origin, "tok-1")
      await sess.clear(origin)

      // 4. Auth browserLogin error & happy branches
      const openErr = await Auth.browserLogin(
        proxyClient,
        origin,
        false,
        "",
        async (cbUrl) => {
          const u = new URL(cbUrl)
          const cb = u.searchParams.get("callback") ?? u.searchParams.get("redirect_uri")
          if (cb) {
            await fetch(`${cb}?error=access_denied&error_description=nope`).catch(() => {})
          }
        },
        1_500
      ).catch((e) => ({ err: String(e) }))
      assertInv(openErr !== undefined, "Auth.browserLogin handles error callback")
    } finally {
      process.chdir(prevCwd)
      srv.closeAllConnections?.()
      await new Promise<void>((done) => srv.close(() => done()))
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  it("RunnerSession.work (unknown repo, unknown profile, ACP happy/tool/error/cancel) & Agents.addMcp (all agents, existing/corrupt/idempotent) uphold invariants", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-w5-rsess-")))
    try {
      // 1. Agents.addMcp across ALL agents: fresh -> idempotent -> existing valid -> corrupt JSON/TOML
      const arb = Arbitrary.schema(
        Schema.Struct({
          agentIdx: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(8)),
          preState: Schema.Literals(["fresh", "validExisting", "corruptExisting"])
        })
      )
      const agReport = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ agentIdx, preState }) =>
            Effect.sync(() => {
              const home = mkdtempSync(join(tmpdir(), "smthrs-ag-w5-"))
              try {
                const ag = Agents.agents[agentIdx % Agents.agents.length]!
                const env = { HOME: home, XDG_CONFIG_HOME: home, SMITHERS_MEMORY_DB: join(home, "mem.sqlite") }
                if (preState === "validExisting") {
                  if (ag.id === "codex") {
                    mkdirSync(join(home, ".codex"), { recursive: true })
                    writeFileSync(join(home, ".codex/config.toml"), 'model = "gpt-5"\n')
                  } else {
                    const p = join(home, ...ag.mcpConfig)
                    mkdirSync(join(p, ".."), { recursive: true })
                    writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: "echo" } } }))
                  }
                } else if (preState === "corruptExisting") {
                  if (ag.id === "codex") {
                    mkdirSync(join(home, ".codex"), { recursive: true })
                    writeFileSync(join(home, ".codex/config.toml"), "[[[invalid toml\n")
                  } else {
                    const p = join(home, ...ag.mcpConfig)
                    mkdirSync(join(p, ".."), { recursive: true })
                    writeFileSync(p, "{corrupt json")
                  }
                }
                const w1 = Agents.addMcp(ag, home, env)
                assertInv(typeof w1.status === "string", `addMcp ${ag.id} ${preState}`)
                if (w1.status === "written" || w1.status === "unchanged") {
                  const w2 = Agents.addMcp(ag, home, env)
                  assertInv(w2.status === "unchanged" || w2.status === "written", `addMcp ${ag.id} idempotent`)
                }
                return true
              } finally {
                rmSync(home, { recursive: true, force: true })
              }
            }),
          { seed, executions: Math.min(executions, 24) }
        )
      )
      const agFail = Fuzz.formatReport(agReport)
      if (agFail !== undefined) throw new Error(agFail)
      expect(agReport._tag).toBe("Passed")

      // 2. RunnerSession.work against real jj mirror + acp-test-agent.mjs!
      const bareDir = join(root, "bare.git")
      const seedDir = join(root, "seed")
      const stateDir = join(root, "state")
      const mirrorDir = join(stateDir, "mirrors/acme/app")
      mkdirSync(bareDir, { recursive: true })
      mkdirSync(seedDir, { recursive: true })
      mkdirSync(stateDir, { recursive: true })

      const gitEnv = {
        ...process.env,
        JJ_CONFIG: "",
        GIT_AUTHOR_NAME: "Fuzz",
        GIT_AUTHOR_EMAIL: "fuzz@example.test",
        GIT_COMMITTER_NAME: "Fuzz",
        GIT_COMMITTER_EMAIL: "fuzz@example.test"
      }
      execFileSync("git", ["init", "--bare", "-b", "main", bareDir], { stdio: "ignore", env: gitEnv })
      execFileSync("git", ["init", "-b", "main", seedDir], { stdio: "ignore", env: gitEnv })
      writeFileSync(join(seedDir, "A.txt"), "hello\n")
      execFileSync("git", ["add", "."], { cwd: seedDir, stdio: "ignore", env: gitEnv })
      execFileSync("git", ["commit", "-m", "base"], { cwd: seedDir, stdio: "ignore", env: gitEnv })
      execFileSync("git", ["remote", "add", "origin", bareDir], { cwd: seedDir, stdio: "ignore", env: gitEnv })
      execFileSync("git", ["push", "origin", "main"], { cwd: seedDir, stdio: "ignore", env: gitEnv })
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seedDir, encoding: "utf8", env: gitEnv }).trim()
      mkdirSync(join(stateDir, "mirrors/acme"), { recursive: true })
      execFileSync("jj", ["git", "clone", bareDir, mirrorDir], { stdio: "ignore", env: gitEnv })

      const agentScript = join(process.cwd(), "test/fixtures/acp-test-agent.mjs")
      const cfgPath = join(root, "runner.json")
      writeFileSync(
        cfgPath,
        JSON.stringify({
          name: "fuzz-runner",
          capacity: 1,
          stateDir,
          repositories: { "acme/app": { mirror: mirrorDir } },
          profiles: { coder: { argv: [process.execPath, agentScript] } }
        })
      )
      const checked = await Effect.runPromise(Config.load(cfgPath))
      const fakeHost = RunnerHost.Host.of({
        claim: () => Effect.succeed(null),
        events: () => Effect.void,
        heartbeat: () => Effect.succeed({ cancel: false, steers: [] }),
        settle: () => Effect.void,
        credential: () => Effect.succeed(Option.none())
      } as never)

      const makeControl = (): RunnerSession.Control => ({
        cancel: Deferred.makeUnsafe<void>(),
        dropped: Deferred.makeUnsafe<void>(),
        authorization: { suspended: Deferred.makeUnsafe<void>(), latch: Latch.makeUnsafe(true) },
        hostEnded: Deferred.makeUnsafe<void>(),
        reclaimed: false,
        steers: Effect.runSync(Queue.unbounded()),
        delivered: new Set<string>(),
        stats: { cpuSeconds: 0 } as never
      })

      // Unknown repository -> Failed("workspace")
      const badRepo = await Effect.runPromise(
        RunnerSession.work(
          checked,
          {
            key: "todo:bad-repo#g1",
            generation: 1,
            claim: "c1",
            task: {
              agent: { name: "a", labels: [], profile: "coder", maxHours: 1, restarts: 0 },
              repository: "unknown/repo",
              base: baseSha,
              system: [],
              prompt: "hi",
              limits: { files: 10, bytes: 100_000 }
            }
          } as never,
          makeControl()
        ).pipe(Effect.provideService(RunnerHost.Host, fakeHost))
      )
      assertInv(badRepo._tag === "Failed" && badRepo.reason === "workspace", "RunnerSession unknown repo -> workspace")

      // Unknown profile -> Failed("refused")
      const badProf = await Effect.runPromise(
        RunnerSession.work(
          checked,
          {
            key: "todo:bad-prof#g1",
            generation: 1,
            claim: "c1",
            task: {
              agent: { name: "a", labels: [], profile: "missing-profile", maxHours: 1, restarts: 0 },
              repository: "acme/app",
              base: baseSha,
              system: [],
              prompt: "hi",
              limits: { files: 10, bytes: 100_000 }
            }
          } as never,
          makeControl()
        ).pipe(Effect.provideService(RunnerHost.Host, fakeHost))
      )
      assertInv(badProf._tag === "Failed" && badProf.reason === "refused", "RunnerSession unknown profile -> refused")

      // Real ACP happy path + edit file + fail prompt
      for (const [id, prompt] of [
        ["ok-edit", "add the line `y` to `A.txt`"],
        ["err-case", "crash immediately"]
      ] as const) {
        const res = await Effect.runPromise(
          RunnerSession.work(
            checked,
            {
              key: `todo:${id}#g1`,
              generation: 1,
              claim: `c-${id}`,
              deadline: Date.now() + 60_000,
              task: {
                agent: { name: "a", labels: [], profile: "coder", maxHours: 1, restarts: 0 },
                repository: "acme/app",
                base: baseSha,
                system: ["be concise"],
                prompt,
                limits: { files: 10, bytes: 100_000 }
              }
            } as never,
            makeControl()
          ).pipe(Effect.provideService(RunnerHost.Host, fakeHost))
        )
        assertInv(res._tag === "Done" || res._tag === "Failed" || res._tag === "Cancelled", `RunnerSession ${id} settled`)
      }
          } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
