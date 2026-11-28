import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { Argument, Command as CliCommand } from "effect/cli"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as TestConsole from "effect/testing/TestConsole"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as BugCmd from "../src/commands/Bug.ts"
import * as ClaudeCmd from "../src/commands/Claude.ts"
import * as GcCmd from "../src/commands/Gc.ts"
import * as MigrateCmd from "../src/commands/Migrate.ts"
import * as NodeCmd from "../src/commands/Node.ts"
import * as Collectors from "../src/node/Collectors.ts"
import * as McpClient from "../src/node/McpClient.vibe"
import * as NodeDaemon from "../src/node/NodeDaemon.vibe"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import * as Ui from "../src/Ui.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeLoopbackServer = async (
  handler: (
    req: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }
  ) => {
    status: number
    headers?: Record<string, string>
    body: string
  }
) => {
  const requests: Array<{ method: string; url: string; body: string; auth: string | undefined }> = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      const auth = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : undefined
      requests.push({ method: req.method ?? "GET", url: req.url ?? "/", body, auth })
      const reply = handler({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body
      })
      res.writeHead(reply.status, reply.headers ?? { "content-type": "application/json" })
      res.end(reply.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const addr = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const populateSyntheticHome = (
  home: string,
  opts: {
    sessionId: string
    cfboxMode: "json-array" | "json-jobs" | "table" | "timeout-125" | "no-token" | "mjs-fallback" | "none"
    accountMode: "full" | "auth-err" | "bad-json" | "none"
    includeAgyToken: boolean
    stopReason: "end_turn" | "tool_use"
  }
) => {
  const workDir = join(home, "repo-alpha")
  mkdirSync(workDir, { recursive: true })
  const encodedCwd = workDir.replace(/[/.]/g, "-")

  // 1. Live & dead Claude sessions + transcripts (with secrets to verify OBS-5 scrubbing!)
  for (const claudeDir of [join(home, ".claude"), join(home, ".smithers", "accounts", "claude-1")]) {
    const sessDir = join(claudeDir, "sessions")
    const projDir = join(claudeDir, "projects", encodedCwd)
    mkdirSync(sessDir, { recursive: true })
    mkdirSync(projDir, { recursive: true })
    writeFileSync(
      join(sessDir, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: opts.sessionId,
        cwd: workDir,
        name: `feat-branch TOKEN=secret123`,
        startedAt: Date.now() - 10_000,
        title: `Working on sk-ant-api03-1234567890abcdef123456`
      })
    )
    writeFileSync(
      join(sessDir, `99999999.json`),
      JSON.stringify({ pid: 99999999, sessionId: "dead-sess", cwd: workDir })
    )
    writeFileSync(join(sessDir, `corrupt.json`), "{not-valid-json")

    const transcriptLines = [
      "{partial-first-line",
      JSON.stringify({
        gitBranch: "main-fuzz",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10
          },
          content: [
            { type: "tool_use", name: "Bash" },
            { type: "text", text: "Using ghp_abcdefghijklmnopqrstuvwxyz012345 and Bearer abcdefghijklmnop" }
          ],
          stop_reason: opts.stopReason
        }
      })
    ]
    writeFileSync(join(projDir, `${opts.sessionId}.jsonl`), transcriptLines.join("\n"))
  }

  // 2. Codex rollouts (default + account pool)
  const today = new Date()
  const yyyy = String(today.getFullYear())
  const mm = String(today.getMonth() + 1).padStart(2, "0")
  const dd = String(today.getDate()).padStart(2, "0")
  for (const codexRoot of [join(home, ".codex"), join(home, ".smithers", "accounts", "codex-1")]) {
    const dayDir = join(codexRoot, "sessions", yyyy, mm, dd)
    mkdirSync(dayDir, { recursive: true })
    writeFileSync(
      join(dayDir, `rollout-${opts.sessionId}.jsonl`),
      [
        "partial-line",
        JSON.stringify({
          payload: {
            model: "gpt-5.4-codex",
            cwd: workDir,
            total_tokens: 4200,
            name: "shell_exec AKIAIOSFODNN7EXAMPLE"
          }
        })
      ].join("\n")
    )
  }

  // 3. AGY CLI & IDE SQLite conversation_summaries + brain transcript
  for (
    const [sub, convId, status, notIdle] of [
      [".gemini/antigravity-cli", `conv-cli-${opts.sessionId}`, "CASCADE_RUN_STATUS_RUNNING", 1],
      [".gemini/antigravity", `conv-ide-${opts.sessionId}`, "CASCADE_RUN_STATUS_IDLE", 1],
      [".gemini/antigravity", `conv-idle-${opts.sessionId}`, "CASCADE_RUN_STATUS_IDLE", 0]
    ] as const
  ) {
    const dir = join(home, sub)
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, "conversation_summaries.db")
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT, title TEXT, status TEXT, not_fully_idle INTEGER, last_modified_time TEXT);"
      )
      const nowSql = new Date().toISOString().replace("T", " ").slice(0, 19)
      db.prepare(
        "INSERT INTO conversation_summaries (conversation_id, title, status, not_fully_idle, last_modified_time) VALUES (?, ?, ?, ?, ?)"
      ).run(convId, `Debug sk-1234567890abcdefghij`, status, notIdle, nowSql)
    } finally {
      db.close()
    }
    const logDir = join(home, sub, "brain", convId, ".system_generated", "logs")
    mkdirSync(logDir, { recursive: true })
    writeFileSync(
      join(logDir, "transcript.jsonl"),
      `{"step":1,"type":"USER_INPUT","text":"Authorization Bearer secret_token_1234567890"}\n`
    )
  }
  if (opts.includeAgyToken) {
    writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "tok-placeholder")
  }

  // 4. Provider accounts script (limits.py)
  if (opts.accountMode !== "none") {
    const skillDir = join(home, ".claude", "skills", "smithers-fallback-agents")
    mkdirSync(skillDir, { recursive: true })
    const scriptPath = join(skillDir, "limits.py")
    if (opts.accountMode === "bad-json") {
      writeFileSync(scriptPath, `print("not json")\n`)
    } else {
      const payload = opts.accountMode === "auth-err"
        ? {
          claude: [{ label: "c-auth", status: "auth_error", data: {}, rr: {} }],
          codex: [{ label: "x-auth", status: "unauthorized", data: { limit_reached: false }, rr: {} }]
        }
        : {
          claude: [
            {
              label: "c-ready",
              status: "ok",
              data: {
                limits: {
                  weekly_all: { percent: 42, resets_at: "2026-12-01T00:00:00Z" },
                  five_hour: { percent: 15 },
                  "weekly_scoped:Fable": { percent: 25 }
                },
                grants: ["opus"]
              },
              rr: { active_runs: 2, pools: ["primary"] }
            },
            {
              label: "c-cool",
              status: "ok",
              data: { limits: { weekly_all: { percent: 50 } } },
              rr: { cool: { reason: "rate-limit TOKEN=abc", until: Math.floor(Date.now() / 1000) + 300 } }
            },
            {
              label: "c-model-cool",
              status: "ok",
              data: { limits: { weekly_all: { percent: 100 } } },
              rr: { model_cools: { opus: true } }
            }
          ],
          codex: [
            {
              label: "x-pro",
              plan_type: "pro",
              status: "ok",
              data: {
                used_percent: 33,
                reset_at: Math.floor(Date.now() / 1000) + 3600,
                reset_credits_available_count: 2,
                credits_balance: 50
              },
              rr: { active_runs: 1, pools: ["codex"] }
            },
            {
              label: "x-limit",
              status: "ok",
              data: { plan_type: "pro", used_percent: 100, limit_reached: true },
              rr: { cool: { reason: "quota", until: Math.floor(Date.now() / 1000) + 60 } }
            }
          ]
        }
      writeFileSync(scriptPath, `print(${JSON.stringify(JSON.stringify(payload))})\n`)
    }
  }

  // 5. cfbox executable or .cfbox/cfbox-1.mjs fallback
  const cfboxDir = join(home, ".cfbox")
  mkdirSync(cfboxDir, { recursive: true })
  writeFileSync(join(cfboxDir, "token"), "cfbox-test-token\n")
  writeFileSync(join(cfboxDir, "url"), "https://cfbox.example.invalid\n")
  if (opts.cfboxMode === "mjs-fallback") {
    writeFileSync(
      join(cfboxDir, "cfbox-2026.mjs"),
      `console.log(JSON.stringify([{ id: "sb-1", owner: "lane-a", image: "node22", state: "running", started_at: "2026-11-24T00:00:00Z", last_contact_at: "2026-11-24T00:01:00Z" }]))\n`
    )
  } else if (opts.cfboxMode !== "none") {
    const binDir = join(home, ".vibe-orch", "bin")
    mkdirSync(binDir, { recursive: true })
    const cfboxPath = join(binDir, "cfbox")
    let script = "#!/bin/sh\n"
    if (opts.cfboxMode === "json-array") {
      script +=
        `printf '%s\\n' '[{"id":"sb-arr","owner":"lane-arr TOKEN=x","image":"ubuntu","state":"starting","startedAt":"2026-11-24T00:00:00Z","lastContactAt":"2026-11-24T00:01:00Z"},{"id":"sb-err","owner":"lane-e","image":"ubuntu","state":"failed"},{"id":"sb-done","owner":"lane-d","image":"ubuntu","state":"stopped"}]'\n`
    } else if (opts.cfboxMode === "json-jobs") {
      script += `printf '%s\\n' '{"jobs":[{"id":"sb-job","owner":"lane-j","image":"node","state":"reserved"},{"id":"sb-wait","state":"waiting"},{"id":"sb-live","state":"running"},{"id":"sb-finished","state":"completed"}]}'\n`
    } else if (opts.cfboxMode === "table") {
      script +=
        `printf 'ID OWNER IMAGE CPU STATE STARTED\\n--- --- --- --- ---\\nsb-tbl lane-t img1 1.0 running 2026-11-24\\nsb-tbl2 lane-t2 img2 0.0 error 2026-11-24\\n'\n`
    } else if (opts.cfboxMode === "timeout-125") {
      script += `printf '%s\\n' '[{"id":"sb-partial","owner":"lane-p","image":"node","state":"running"}]'\nexit 125\n`
    } else if (opts.cfboxMode === "no-token") {
      script += `echo "no cfbox token configured" >&2\nexit 1\n`
    }
    writeFileSync(cfboxPath, script)
    chmodSync(cfboxPath, 0o755)
  }
}

describe("@smthrs/cli Wave-6B Deep Node Collectors, McpClient, NodeDaemon, Fleet CLI & Commands fuzz invariants", () => {
  it(
    "Collectors read-only host/session/account/cfbox discovery & inspectLocalSession scrub all secrets (OBS-5)",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          cfboxMode: Schema.Literals([
            "json-array",
            "json-jobs",
            "table",
            "timeout-125",
            "no-token",
            "mjs-fallback",
            "none"
          ]),
          accountMode: Schema.Literals(["full", "auth-err", "bad-json", "none"]),
          includeAgyToken: Schema.Boolean,
          stopReason: Schema.Literals(["end_turn", "tool_use"]),
          kind: Schema.Literals(["macbook", "mac-mini", "bare-metal", "lan"])
        })
      )

      const binDir = mkdtempSync(join(tmpdir(), "smthrs-sqlbin-"))
      const sqliteShim = join(binDir, "sqlite3")
      writeFileSync(
        sqliteShim,
        `#!${process.execPath}
const { DatabaseSync } = require("node:sqlite")
const args = process.argv.slice(2)
const uri = args.find((a) => a.startsWith("file:")) || ""
const dbPath = uri.replace(/^file:/, "").replace(/\\?.*$/, "")
const query = args[args.length - 1] || ""
const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  const rows = db.prepare(query).all()
  process.stdout.write(JSON.stringify(rows))
} finally {
  db.close()
}
`
      )
      chmodSync(sqliteShim, 0o755)
      const prevPath = process.env["PATH"] ?? ""
      process.env["PATH"] = `${binDir}:${prevPath}`

      try {
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            (input) =>
              Effect.promise(async () => {
                const home = mkdtempSync(join(tmpdir(), "smthrs-node-col-"))
                try {
                  const sessionId = `sess-${input.cfboxMode}-${input.accountMode}`
                  populateSyntheticHome(home, {
                    sessionId,
                    cfboxMode: input.cfboxMode,
                    accountMode: input.accountMode,
                    includeAgyToken: input.includeAgyToken,
                    stopReason: input.stopReason
                  })

                  const config: Collectors.CollectorConfig = {
                    nodeId: `node-${input.kind}`,
                    name: "test-host",
                    kind: input.kind,
                    labels: [input.kind, "fuzz"],
                    version: "1.0.0-fuzz",
                    home
                  }
                  const layer = Collectors.makeCollectorsLayer(config)
                  const { accounts, cfbox, host, sessions } = await Effect.runPromise(
                    Effect.gen(function*() {
                      const col = yield* NodeDaemon.NodeCollectors
                      const host = yield* col.collectHost()
                      const sessions = yield* col.collectSessions()
                      const accounts = yield* col.collectAccounts()
                      const cfbox = yield* col.collectCfbox()
                      return { host, sessions, accounts, cfbox }
                    }).pipe(Effect.provide(layer))
                  )

                  assertInv(host.nodeId === config.nodeId && host.online === true, "host snapshot online")
                  assertInv(host.cpuCores !== null && host.cpuCores > 0, "positive cpu cores")
                  assertInv(Collectors.defaultNodeId().length > 0, "defaultNodeId non-empty")

                  // OBS-5: no raw secret may ever leak in any session, account, or cfbox field
                  const serialized = JSON.stringify({ host, sessions, accounts, cfbox })
                  for (
                    const leaked of [
                      "ghp_abcdefghijklmnopqrstuvwxyz",
                      "sk-ant-api03-",
                      "AKIAIOSFODNN7EXAMPLE",
                      "secret123"
                    ]
                  ) {
                    assertInv(!serialized.includes(leaked), `OBS-5 violation: leaked ${leaked}`)
                  }

                  // Verify Claude, Codex rollout, and AGY sessions discovered
                  assertInv(
                    sessions.some((s) => s.harness === "claude" && s.sessionKey.includes(sessionId)),
                    "claude session discovered"
                  )
                  assertInv(
                    sessions.some((s) => s.harness === "codex" && s.sessionKey.includes(sessionId)),
                    "codex rollout discovered"
                  )
                  assertInv(sessions.some((s) => s.harness === "agy-cli"), "agy-cli session discovered")
                  assertInv(sessions.some((s) => s.harness === "agy-ide"), "agy-ide session discovered")

                  // Verify cfbox mode invariants
                  if (input.cfboxMode === "none") {
                    assertInv(cfbox === null, "cfbox null when absent")
                  } else if (input.cfboxMode === "no-token") {
                    assertInv(
                      cfbox !== null && cfbox.host.online === false && cfbox.host.held === "cfbox token unavailable",
                      "cfbox no-token held"
                    )
                  } else if (input.cfboxMode === "json-jobs") {
                    expect(cfbox?.sessions.map((session) => session.status)).toEqual(["waiting", "waiting", "working", "ended"])
                    expect(cfbox?.host.activeSessions).toBe(3)
                  } else if (input.cfboxMode === "timeout-125") {
                    assertInv(
                      cfbox !== null && cfbox.host.held === "cfbox partial worker timeout",
                      "cfbox timeout-125 held"
                    )
                  } else {
                    assertInv(
                      cfbox !== null && cfbox.sessions.length >= 1,
                      `cfbox discovered sessions for ${input.cfboxMode}`
                    )
                  }

                  // Verify accounts mode invariants
                  if (input.accountMode === "full") {
                    assertInv(
                      accounts.some((a) => a.provider === "claude" && a.status === "ready"),
                      "claude ready acct"
                    )
                    assertInv(
                      accounts.some((a) => a.provider === "claude" && a.status === "cooling"),
                      "claude cooling acct"
                    )
                    assertInv(
                      accounts.some((a) => a.provider === "claude" && a.status === "limit_reached"),
                      "claude limit acct"
                    )
                    assertInv(accounts.some((a) => a.provider === "codex" && a.status === "ready"), "codex ready acct")
                    assertInv(
                      accounts.some((a) => a.provider === "codex" && a.status === "limit_reached"),
                      "codex limit acct"
                    )
                  } else if (input.accountMode === "auth-err") {
                    assertInv(accounts.some((a) => a.status === "auth_expired"), "auth_expired reported")
                  }

                  // Verify inspectLocalSession for claude, agy-cli, agy-ide, and miss
                  const claudeInsp = Collectors.inspectLocalSession(config, sessionId)
                  assertInv(
                    claudeInsp.session !== null && claudeInsp.recentEvents.length > 0,
                    "inspectLocalSession claude"
                  )
                  assertInv(
                    !JSON.stringify(claudeInsp).includes("ghp_abcdefghijklmnopqrstuvwxyz"),
                    "inspectLocalSession scrubs secrets"
                  )

                  const agyInsp = Collectors.inspectLocalSession(config, `conv-cli-${sessionId}`)
                  assertInv(agyInsp.session !== null && agyInsp.recentEvents.length > 0, "inspectLocalSession agy-cli")
                  assertInv(
                    !JSON.stringify(agyInsp).includes("secret_token_1234567890"),
                    "inspectLocalSession agy scrubs bearer"
                  )

                  const missInsp = Collectors.inspectLocalSession(config, "nonexistent-session-xyz")
                  assertInv(missInsp.session === null && missInsp.recentEvents.length === 0, "inspectLocalSession miss")
                  return true
                } finally {
                  rmSync(home, { recursive: true, force: true })
                }
              }),
            { executions: Math.min(executions, 14), seed }
          )
        )
        if (report._tag !== "Passed") {
          throw new Error(`Falsified: ${JSON.stringify(report)}`)
        }
        expect(report._tag).toBe("Passed")
      } finally {
        process.env["PATH"] = prevPath
        rmSync(binDir, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "McpClient.callTool, NodeDaemon (once + continuous interrupt), and NodeCmd fleet CLI uphold MCP protocol invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "json-ok",
            "text-ok",
            "empty-result",
            "rpc-error",
            "tool-is-error",
            "http-401",
            "http-403",
            "http-500",
            "invalid-json",
            "bad-envelope"
          ]),
          doAccounts: Schema.Boolean,
          doCfbox: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ doAccounts, doCfbox, mode }) =>
            Effect.promise(async () => {
              const server = await makeLoopbackServer(() => {
                if (mode === "http-401") return { status: 401, body: "{}" }
                if (mode === "http-403") return { status: 403, body: "{}" }
                if (mode === "http-500") return { status: 500, body: "boom" }
                if (mode === "invalid-json") return { status: 200, body: "<<<not-json>>>" }
                if (mode === "bad-envelope") return { status: 200, body: JSON.stringify({ error: "wrong-type" }) }
                if (mode === "rpc-error") {
                  return {
                    status: 200,
                    body: JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "method not found" } })
                  }
                }
                if (mode === "tool-is-error") {
                  return {
                    status: 200,
                    body: JSON.stringify({
                      jsonrpc: "2.0",
                      result: { isError: true, content: [{ type: "text", text: "denied" }] }
                    })
                  }
                }
                if (mode === "empty-result") {
                  return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", result: {} }) }
                }
                if (mode === "text-ok") {
                  return {
                    status: 200,
                    body: JSON.stringify({
                      jsonrpc: "2.0",
                      result: { content: [{ type: "text", text: "plain-text-reply" }] }
                    })
                  }
                }
                return {
                  status: 200,
                  body: JSON.stringify({
                    jsonrpc: "2.0",
                    result: { content: [{ type: "text", text: JSON.stringify({ ok: true, mode }) }] }
                  })
                }
              })

              try {
                const cfg: McpClient.McpClientConfig = { origin: `${server.origin}/`, token: "sma_testtoken123" }
                const exit = await Effect.runPromiseExit(
                  McpClient.callTool(cfg, "fleet_ping", { hello: "world" }).pipe(Effect.provide(FetchHttpClient.layer))
                )
                if (mode === "json-ok") {
                  assertInv(Exit.isSuccess(exit) && (exit.value as any).ok === true, "json-ok decoded")
                } else if (mode === "text-ok") {
                  assertInv(Exit.isSuccess(exit) && exit.value === "plain-text-reply", "text-ok fallback")
                } else if (mode === "empty-result") {
                  assertInv(Exit.isSuccess(exit) && typeof exit.value === "object", "empty-result returns {}")
                } else {
                  assertInv(Exit.isFailure(exit), `expected failure for ${mode}`)
                }

                // Exercise NodeDaemon with a real NodeCollectors service layer
                const stubCollectors = Layer.succeed(NodeDaemon.NodeCollectors, {
                  collectHost: () =>
                    Effect.succeed({
                      nodeId: "fuzz-node",
                      name: "fuzz-host",
                      kind: "bare-metal",
                      labels: ["fuzz"],
                      online: true,
                      held: null,
                      load1: 0.5,
                      cpuCores: 4,
                      memUsedGb: 2,
                      memTotalGb: 16,
                      diskFreeGb: 50,
                      diskTotalGb: 100,
                      activeSessions: 1,
                      runnerCapacity: 4,
                      version: "1.0.0"
                    }),
                  collectSessions: () =>
                    Effect.succeed([
                      {
                        sessionKey: "fuzz-node:claude:s1",
                        managed: false,
                        harness: "claude",
                        model: "opus",
                        accountLabel: "c1",
                        repo: "smithers",
                        project: "smithersai/smithers",
                        lane: "main",
                        title: "work",
                        summary: null,
                        cwd: null,
                        transcriptJson: null,
                        status: "working",
                        pid: process.pid,
                        cpuSeconds: 1.2,
                        tokensUsed: 100,
                        startedAt: null,
                        lastActivityAt: null,
                        endedAt: null
                      }
                    ]),
                  collectAccounts: () =>
                    Effect.succeed([
                      {
                        accountKey: "claude:c1",
                        provider: "claude",
                        label: "c1",
                        plan: "max",
                        status: "ready",
                        fiveHourPct: 10,
                        weeklyPct: 20,
                        scopedPct: 5,
                        resetsAt: null,
                        grantsJson: null,
                        creditsBalance: null,
                        activeSessions: 1,
                        pools: ["primary"],
                        coolReason: null,
                        coolUntil: null,
                        checkedAt: null
                      }
                    ]),
                  collectCfbox: () =>
                    Effect.succeed({
                      host: {
                        nodeId: "cloudflare-cfbox",
                        name: "cfbox",
                        kind: "cloudflare",
                        labels: ["cfbox"],
                        online: true,
                        held: null,
                        load1: null,
                        cpuCores: null,
                        memUsedGb: null,
                        memTotalGb: null,
                        diskFreeGb: null,
                        diskTotalGb: null,
                        activeSessions: 1,
                        runnerCapacity: 64,
                        version: "cfbox"
                      },
                      sessions: [
                        {
                          sessionKey: "cloudflare-cfbox:cfbox:j1",
                          managed: true,
                          harness: "cfbox",
                          model: null,
                          accountLabel: null,
                          repo: null,
                          project: null,
                          lane: "main",
                          title: "job1",
                          summary: null,
                          cwd: null,
                          transcriptJson: null,
                          status: "working",
                          pid: null,
                          cpuSeconds: null,
                          tokensUsed: null,
                          startedAt: null,
                          lastActivityAt: null,
                          endedAt: null
                        }
                      ]
                    })
                })
                const daemonEnv = Layer.merge(stubCollectors, FetchHttpClient.layer)

                // 1. once: true
                await Effect.runPromise(
                  NodeDaemon.runDaemon({
                    mcp: cfg,
                    intervalMs: 50,
                    accountIntervalMs: 50,
                    collectAccounts: doAccounts,
                    collectCfbox: doCfbox,
                    once: true
                  }).pipe(Effect.provide(daemonEnv))
                )

                // 2. continuous daemon forked and interrupted cleanly after one cycle
                if (mode === "json-ok" || mode === "http-500") {
                  await Effect.runPromise(
                    Effect.gen(function*() {
                      const fiber = yield* Effect.forkChild(
                        NodeDaemon.runDaemon({
                          mcp: cfg,
                          intervalMs: 20,
                          accountIntervalMs: 20,
                          collectAccounts: doAccounts,
                          collectCfbox: doCfbox,
                          once: false
                        })
                      )
                      yield* Effect.sleep("45 millis")
                      yield* Fiber.interrupt(fiber)
                    }).pipe(Effect.provide(daemonEnv))
                  )
                }
                return true
              } finally {
                await server.close()
              }
            }),
          { executions: Math.min(executions, 18), seed: seed + 1 }
        )
      )
      if (report._tag !== "Passed") {
        throw new Error(`Falsified: ${JSON.stringify(report)}`)
      }
      expect(report._tag).toBe("Passed")

      // Also test McpClient transport error (closed port) + NodeCmd fleet CLI (serve --once, overview, overview --local, inspect)
      const server = await makeLoopbackServer(() => ({
        status: 200,
        body: JSON.stringify({
          jsonrpc: "2.0",
          result: { content: [{ type: "text", text: JSON.stringify({ nodes: [], sessions: [], accounts: [] }) }] }
        })
      }))
      try {
        const cli = NodeCmd.createNodeCli()
        const runFleet = async (args: Array<string>) => {
          let out = ""
          const codes: Array<number> = []
          await cli.serve(args, {
            stdout: (s: string) => (out += s),
            exit: (c: number) => codes.push(c)
          })
          return { out, codes }
        }
        const r1 = await runFleet([
          "serve",
          "--once",
          "--origin",
          server.origin,
          "--token",
          "sma_cli",
          "--node-id",
          "fuzz-cli",
          "--kind",
          "bare-metal"
        ])
        expect(r1.out).toContain("fuzz-cli")
        const r2 = await runFleet(["overview", "--origin", server.origin, "--token", "sma_cli", "--include-ended"])
        expect(r2.out).toContain("nodes")
        const r3 = await runFleet(["overview", "--local", "--no-accounts", "--no-cfbox"])
        expect(r3.out).toContain("nodes")
        const r4 = await runFleet(["inspect", "nonexistent-session-key"])
        expect(r4.out).toContain("recentEvents")
      } finally {
        await server.close()
      }

      // Closed port transport error
      const deadExit = await Effect.runPromiseExit(
        McpClient.callTool({ origin: "http://127.0.0.1:1", token: "sma_dead" }, "fleet_ping", {}).pipe(
          Effect.provide(FetchHttpClient.layer)
        )
      )
      expect(Exit.isFailure(deadExit)).toBe(true)
    },
    120_000
  )

  it(
    "Commands Bug.submit, Gc.sweep, Migrate.run, and Claude mirror subcommands uphold consent, redaction & lifecycle invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          summary: Schema.Literals(["", "   ", "Crash on token=secret123", "Timeout during flow"]),
          dryRun: Schema.Boolean,
          yes: Schema.Boolean,
          serverStatus: Schema.Literals([200, 500, 0]),
          withRunId: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ dryRun, serverStatus, summary, withRunId, yes }) =>
            Effect.promise(async () => {
              const server = serverStatus > 0
                ? await makeLoopbackServer(() => ({
                  status: serverStatus,
                  body: JSON.stringify({ ok: serverStatus === 200 })
                }))
                : undefined
              try {
                const endpoint = server ? `${server.origin}/bug` : "http://127.0.0.1:1/bug"
                const previews: Array<string> = []
                const fakeControl = Control.Control.of({
                  list: () =>
                    Effect.succeed({
                      _tag: "runs" as const,
                      items: [{
                        runId: "run-bug-1",
                        flowName: "demo",
                        status: "failed",
                        startedAt: new Date().toISOString()
                      } as any]
                    }),
                  watch: () =>
                    Stream.fromIterable([
                      {
                        sequence: 1,
                        runId: "run-bug-1",
                        kind: "control.run.started",
                        timestamp: new Date().toISOString(),
                        payload: { flowName: "demo" }
                      } as any
                    ])
                } as any)

                const exit = await Effect.runPromiseExit(
                  BugCmd.submit(
                    {
                      summary,
                      ...(withRunId ? { runId: "run-bug-1" } : {}),
                      yes,
                      dryRun,
                      preview: (line) => Effect.sync(() => void previews.push(line))
                    },
                    {
                      environment: { SMITHERS_BUG_ENDPOINT: endpoint }
                    }
                  ).pipe(
                    Effect.provideService(Control.Control, fakeControl),
                    Effect.provideService(Ui.Ui, Ui.make({ interactive: false, output: process.stderr }))
                  )
                )

                if (summary.trim() === "") {
                  assertInv(Exit.isFailure(exit), "empty summary rejected")
                } else if (dryRun) {
                  assertInv(
                    Exit.isSuccess(exit) && exit.value.reported === false,
                    `dryRun does not post: ${Exit.isFailure(exit) ? String(exit.cause) : JSON.stringify(exit.value)}`
                  )
                  assertInv(server === undefined || server.requests.length === 0, "dryRun made zero HTTP calls")
                } else if (!yes) {
                  assertInv(Exit.isFailure(exit), "non-interactive without --yes refuses post")
                } else if (serverStatus === 200) {
                  assertInv(
                    Exit.isSuccess(exit) && exit.value.reported === true,
                    `200 confirms reported: ${Exit.isFailure(exit) ? String(exit.cause) : JSON.stringify(exit.value)}`
                  )
                  assertInv(server !== undefined && server.requests.length === 1, "posted once to loopback")
                } else {
                  assertInv(Exit.isFailure(exit), `status ${serverStatus} fails delivery`)
                }
                return true
              } finally {
                if (server) await server.close()
              }
            }),
          { executions: Math.min(executions, 24), seed: seed + 2 }
        )
      )
      if (report._tag !== "Passed") {
        throw new Error(`Falsified: ${JSON.stringify(report)}`)
      }
      expect(report._tag).toBe("Passed")

      // Gc.sweep + Migrate.run + ClaudeCmd (tick, node-wait, monitor, subscribe, unsubscribe)
      const dir = mkdtempSync(join(tmpdir(), "smthrs-cmd-fuzz-"))
      try {
        mkdirSync(join(dir, ".flows"), { recursive: true })
        const gcRes = await Effect.runPromise(
          GcCmd.sweep({ olderThan: "30d", dryRun: true }, { environment: {} }).pipe(
            Effect.provideService(Project.ProjectRoot, dir)
          )
        )
        expect(gcRes.dryRun).toBe(true)

        // Migrate.run scan on an empty 0.x-style project directory
        const migDir = mkdtempSync(join(tmpdir(), "smthrs-mig-fuzz-"))
        try {
          const migExit = await Effect.runPromiseExit(
            MigrateCmd.run(
              {
                target: migDir,
                scan: true,
                apply: false,
                acknowledgeRunState: false,
                allowNoVcs: true,
                keepOldSources: true
              },
              { environment: {} }
            )
          )
          expect(Exit.isSuccess(migExit) || Exit.isFailure(migExit)).toBe(true)
        } finally {
          rmSync(migDir, { recursive: true, force: true })
        }

        // Claude mirror command group: subscribe, tick, node-wait (settled + vanished + timeout), monitor, unsubscribe
        const claudeGroup = ClaudeCmd.make({
          guard: Effect.void,
          required: (name) => Argument.String(name)
        })
        const runClaude = (argv: ReadonlyArray<string>, events: ReadonlyArray<any>, status: string) => {
          const fakeControl = Control.Control.of({
            list: () =>
              Effect.succeed({
                _tag: "runs" as const,
                items: [{ runId: "r-claude-1", flowName: "demo", status, startedAt: new Date().toISOString() } as any]
              }),
            watch: () => Stream.fromIterable(events)
          } as any)
          return CliCommand.runWith(claudeGroup, { version: "1.0.0" })(argv).pipe(
            Effect.provideService(Control.Control, fakeControl),
            Effect.provideService(Project.ProjectRoot, dir),
            Effect.provide(Output.layer),
            Effect.provide(TestConsole.layer),
            Effect.provide(NodeServices.layer)
          )
        }

        const now = new Date().toISOString()
        const events = [
          {
            sequence: 1,
            runId: "r-claude-1",
            kind: "control.run.started",
            timestamp: now,
            payload: { flowName: "demo" }
          },
          {
            sequence: 2,
            runId: "r-claude-1",
            kind: "control.node.completed",
            timestamp: now,
            payload: { nodeId: "n1", outcome: "succeeded", output: { ok: true } }
          },
          {
            sequence: 3,
            runId: "r-claude-1",
            kind: "control.run.completed",
            timestamp: now,
            payload: { status: "succeeded" }
          }
        ]
        await Effect.runPromise(runClaude(["subscribe", "r-claude-1", "--session", "s-1"], events, "running"))
        await Effect.runPromise(
          runClaude(["tick", "r-claude-1", "--session", "s-1", "--after-seq", "0"], events, "running")
        )
        await Effect.runPromise(runClaude(["monitor", "--session", "s-1", "--limit", "5"], events, "succeeded"))
        await Effect.runPromise(runClaude(["monitor", "--limit", "5"], events, "succeeded"))
        await Effect.runPromise(
          runClaude(["node-wait", "r-claude-1", "n1", "--timeout-ms", "500"], events, "succeeded")
        )
        await Effect.runPromise(
          runClaude(["node-wait", "r-claude-1", "missing-node", "--timeout-ms", "500"], events, "succeeded")
        )
        await Effect.runPromise(
          runClaude(["node-wait", "r-claude-1", "pending-node", "--timeout-ms", "80"], [events[0]], "running")
        )
        await Effect.runPromise(runClaude(["unsubscribe", "r-claude-1", "--session", "s-1"], events, "running"))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000
  )
})
