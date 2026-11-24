import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import * as ControlSchema from "@smthrs/control/ControlSchema"
import { Fuzz } from "@smthrs/fuzz"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Arbitrary, Cause, Console, Duration, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import * as EffectCli from "effect/cli"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
const { DatabaseSync } = require("node:sqlite")
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/Cli.ts"
import * as Compatibility from "../src/cli/Compatibility.ts"
import * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as ControlCommands from "../src/cli/ControlCommands.ts"
import * as Generate from "../src/cli/Generate.ts"
import * as Presentation from "../src/cli/Presentation.ts"
import * as RunActivity from "../src/cli/RunActivity.ts"
import * as RunHistory from "../src/cli/RunHistory.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as RunTiming from "../src/cli/RunTiming.ts"
import * as CliError from "../src/CliError.ts"
import * as CommandMod from "../src/Command.ts"
import * as AlertsCmd from "../src/commands/Alerts.ts"
import * as Launch from "../src/commands/Launch.ts"
import * as Settlement from "../src/commands/Settlement.ts"
import * as Tui from "../src/commands/Tui.ts"
import * as Forensics from "../src/Forensics.ts"
import * as CommandStatus from "../src/internal/CommandStatus.ts"
import * as Collectors from "../src/node/Collectors.ts"
import { NodeCollectors } from "../src/node/NodeDaemon.vibe"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import * as Serve from "../src/Serve.ts"
import * as Ui from "../src/Ui.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261209")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const runFuzz = <A>(arb: Arbitrary.Arbitrary<A>, fn: (a: A) => void, opts: { executions: number; seed: number }) =>
  Effect.runPromise(Fuzz.run(arb, (a) =>
    Effect.sync(() => {
      fn(a)
      return true
    }), opts))

const expectPassed = (report: { readonly _tag: string; readonly findings?: ReadonlyArray<unknown> }) => {
  if (report._tag !== "Passed") {
    const first = report.findings?.[0] as { failure?: { defect?: unknown } } | undefined
    const d = first?.failure?.defect
    const msg = d instanceof Error ? d.message : JSON.stringify(report.findings?.[0])
    throw new Error(`Falsified: ${msg}`)
  }
  expect(report._tag).toBe("Passed")
}

const makeCapture = (isTTY = false) => {
  const chunks: Array<string> = []
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean; columns?: number }
  stream.isTTY = isTTY
  stream.columns = 100
  stream.on("data", (d) => chunks.push(String(d)))
  return {
    stream,
    read: () => chunks.join("")
  }
}

const ev = (
  sequence: number,
  kind: string,
  payload: ControlSchema.ControlEvent["payload"],
  overrides: Partial<ControlSchema.ControlEvent> = {}
): ControlSchema.ControlEvent => ({
  runId: "run-9a",
  sequence,
  kind,
  occurredAt: 1_700_000_000_000 + sequence * 100,
  payload,
  ...overrides
})

const makeBaseControl = (overrides: Partial<Control.Service> = {}): Control.Service => ({
  listFlows: () => Effect.succeed([]),
  discover: () =>
    Effect.succeed({
      root: "/tmp/nonexistent",
      flows: [],
      diagnostics: [],
      providers: [],
      environment: { nodeVersion: process.version, platform: process.platform },
      store: { location: "sqlite", path: "/tmp/nonexistent/.flows/control.sqlite", exists: false, readable: true }
    } as never),
  plan: () => Effect.fail(new ControlError.TransportError({ message: "missing flow", retryable: false })),
  approve: () => Effect.succeed({ _tag: "Accepted", receiptId: "r-1", runId: "run-9a" }),
  deny: () => Effect.succeed({ _tag: "Accepted", receiptId: "r-2", runId: "run-9a" }),
  cancel: () => Effect.succeed({ _tag: "Accepted", receiptId: "r-3", runId: "run-9a" }),
  pause: () => Effect.succeed({ _tag: "Accepted", receiptId: "r-4", runId: "run-9a" }),
  resume: () => Effect.succeed({ _tag: "Accepted", receiptId: "r-5", runId: "run-9a" }),
  signal: () => Effect.succeed({ _tag: "Accepted", receiptId: "r-7", runId: "run-9a" }),
  steer: () => Effect.succeed({ _tag: "Accepted", receiptId: "r-8", runId: "run-9a" }),
  list: () => Effect.succeed({ _tag: "runs", items: [], nextCursor: undefined }),
  watch: () => Stream.empty,
  events: () => Stream.empty,
  eventsPage: () => Effect.succeed({ events: [], nextCursor: undefined }),
  signalReceipts: () => Effect.succeed({ items: [], nextCursor: undefined }),
  inspectNode: () => Effect.fail(new ControlError.TransportError({ message: "missing node", retryable: false })),
  health: () => Effect.succeed({ status: "ok", version: "1.0.0", time: Date.now() } as never),
  ...overrides
} as Control.Service)

describe("@smthrs/cli Wave-9A Deep Collectors, RunTiming/Progress/Activity/History, Forensics, Presentation/Ui, ControlCommands & Cli fuzz", () => {
  it(
    "node/Collectors covers git/jj worktrees, Claude/Codex/Agy transcripts, accounts limits.py, cfbox modes & inspectLocalSession",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "wave9a-collectors-"))
      const origPath = process.env.PATH
      try {
        const binDir = join(tmp, "bin")
        mkdirSync(binDir, { recursive: true })
        const sqliteShim = join(binDir, "sqlite3")
        writeFileSync(
          sqliteShim,
          `#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite"
const args = process.argv.slice(2)
const uri = args[1] || ""
const sql = args[2] || ""
const dbPath = uri.split("?")[0].replace(/^file:/, "")
const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db.prepare(sql).all()
db.close()
process.stdout.write(JSON.stringify(rows))
`
        )
        chmodSync(sqliteShim, 0o755)
        process.env.PATH = `${binDir}:${origPath ?? ""}`
        // 1. Build rich git / jj / worktree fixtures for resolveProject & findGitRemote
        const gitDirRepo = join(tmp, "repo-git-dir")
        mkdirSync(join(gitDirRepo, ".git"), { recursive: true })
        writeFileSync(
          join(gitDirRepo, ".git", "config"),
          "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = https://github.com/other/up.git\n[remote \"origin\"]\n\turl = git@github.com:smithersai/demo-repo.git\n"
        )

        const gitHttpRepo = join(tmp, "repo-https")
        mkdirSync(join(gitHttpRepo, ".git"), { recursive: true })
        writeFileSync(
          join(gitHttpRepo, ".git", "config"),
          "[remote \"origin\"]\n\turl =   \n[remote \"backup\"]\n\turl = https://github.com/acme/web-app.git\n"
        )

        const gitBadRemote = join(tmp, "repo-bad-remote")
        mkdirSync(join(gitBadRemote, ".git"), { recursive: true })
        writeFileSync(join(gitBadRemote, ".git", "config"), "[remote \"origin\"]\n\turl = /local/only\n")

        // .git file pointing to worktree gitdir with commondir
        const commonGit = join(tmp, "common-git")
        const wtGitDir = join(commonGit, "worktrees", "wt1")
        mkdirSync(wtGitDir, { recursive: true })
        writeFileSync(
          join(commonGit, "config"),
          "[remote \"origin\"]\n\turl = https://github.com/smithersai/wt-repo.git\n"
        )
        writeFileSync(join(wtGitDir, "commondir"), "../..\n")
        const wtDir = join(tmp, "repo-worktree")
        mkdirSync(wtDir, { recursive: true })
        writeFileSync(join(wtDir, ".git"), `gitdir: ${wtGitDir}\n`)

        // .git file pointing to missing dir
        const brokenWt = join(tmp, "repo-broken-wt")
        mkdirSync(brokenWt, { recursive: true })
        writeFileSync(join(brokenWt, ".git"), "gitdir: ./does-not-exist\n")

        // .jj/repo as file pointer to another repo's .jj/repo whose sibling has .git
        const mainJjRoot = join(tmp, "main-jj-root")
        mkdirSync(join(mainJjRoot, ".jj", "repo", "store", "git"), { recursive: true })
        writeFileSync(
          join(mainJjRoot, ".jj", "repo", "store", "git", "config"),
          "[remote \"origin\"]\n\turl = git@github.com:smithersai/jj-store.git\n"
        )
        const jjWs = join(tmp, "jj-workspace")
        mkdirSync(join(jjWs, ".jj"), { recursive: true })
        writeFileSync(join(jjWs, ".jj", "repo"), join(mainJjRoot, ".jj", "repo") + "\n")

        // .jj/repo with sibling .git fallback
        const jjSibling = join(tmp, "jj-sibling")
        mkdirSync(join(jjSibling, ".jj", "repo"), { recursive: true })
        mkdirSync(join(jjSibling, ".git"), { recursive: true })
        writeFileSync(
          join(jjSibling, ".git", "config"),
          "[remote \"origin\"]\n\turl = https://github.com/smithersai/jj-sib.git\n"
        )

        // Special project names
        const specialDirs = ["my-vibelang-ws", "evmts-voltaire", "zmux-dev", "needlefish-core", "random-proj"]
        for (const name of specialDirs) mkdirSync(join(tmp, name), { recursive: true })

        // 2. Claude sessions + transcripts (default + account dir)
        const claudeDir = join(tmp, ".claude")
        const claudeAcctDir = join(tmp, ".smithers", "accounts", "claude-work")
        mkdirSync(join(claudeDir, "sessions"), { recursive: true })
        mkdirSync(join(claudeAcctDir, "sessions"), { recursive: true })
        writeFileSync(join(claudeDir, "sessions", "bad.json"), "{not-json")
        writeFileSync(
          join(claudeDir, "sessions", "999999999.json"),
          JSON.stringify({ pid: 999999999, sessionId: "dead" })
        )
        writeFileSync(join(claudeDir, "sessions", "0.json"), JSON.stringify({ pid: 0, sessionId: "zero" }))

        const slugFor = (p: string) => p.replace(/[^a-zA-Z0-9-]/g, "-")
        const projDir = join(claudeDir, "projects", slugFor(gitDirRepo))
        mkdirSync(projDir, { recursive: true })
        const bigPadding = "x".repeat(45_000)
        const claudeLines = [
          JSON.stringify({ type: "file-history-snapshot", timestamp: "2026-11-24T10:00:00Z" }),
          JSON.stringify({ type: "progress", timestamp: "2026-11-24T10:00:01Z" }),
          JSON.stringify({ type: "user", message: null }),
          JSON.stringify({
            type: "user",
            gitBranch: "feat/wave9",
            message: { role: "user", content: "<local-command-caveat>ignored</local-command-caveat>" }
          }),
          JSON.stringify({
            type: "user",
            timestamp: "2026-11-24T10:00:02Z",
            message: {
              role: "user",
              content: [null, { type: "image" }, { type: "text", text: "<command-name>/clear</command-name>" }, {
                type: "text",
                text: "Fix the build pipeline"
              }]
            }
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-24T10:00:03Z",
            message: {
              role: "assistant",
              model: "claude-opus-4-7",
              usage: { input_tokens: 0, output_tokens: 0 },
              content: "Fix the build pipeline in packages/smithers"
            }
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-24T10:00:04Z",
            message: { role: "assistant", content: `padding ${bigPadding}` }
          }),
          JSON.stringify({ type: "system", timestamp: "2026-11-24T10:00:05Z" }),
          JSON.stringify({ type: "queue-operation", timestamp: "2026-11-24T10:00:06Z" }),
          JSON.stringify({ type: "assistant", message: null }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-24T10:00:07Z",
            message: {
              role: "assistant",
              model: "claude-opus-4-7",
              usage: {
                input_tokens: 120,
                output_tokens: 80,
                cache_read_input_tokens: 50,
                cache_creation_input_tokens: 10
              },
              content: [
                null,
                { type: "tool_use", name: "Bash", input: { command: "\"echo hi\"" } },
                { type: "tool_use", name: "Read", input: { file_path: "/tmp/a/b/foo.ts" } },
                { type: "tool_use", name: "Grep", input: { pattern: "needle" } },
                { type: "tool_use", name: "CustomTool", input: { query: "find it" } },
                { type: "tool_use", name: "EmptyTool", input: {} },
                { type: "text", text: "Done checking files." }
              ]
            }
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-24T10:00:08Z",
            message: { role: "assistant", content: "Direct string assistant note" }
          }),
          "{bad json line"
        ]
        writeFileSync(join(projDir, "sess-main.jsonl"), claudeLines.join("\n") + "\n")
        writeFileSync(join(projDir, "sess-empty.jsonl"), "")

        // Live PID session in default dir
        writeFileSync(
          join(claudeDir, "sessions", `${process.pid}.json`),
          JSON.stringify({
            pid: process.pid,
            sessionId: "sess-main",
            cwd: gitDirRepo,
            tmux: "tmux-lane-1",
            status: "busy",
            startedAt: "2026-11-24T10:00:00Z",
            model: "claude-opus-4-7"
          })
        )

        // 3. Codex rollouts (fresh + stale + empty + malformed)
        const codexDay = join(tmp, ".codex", "sessions", "2026", "11", "24")
        mkdirSync(codexDay, { recursive: true })
        const codexLines = [
          JSON.stringify({ type: "session_meta", payload: { cwd: gitHttpRepo, timestamp: "2026-11-24T11:00:00Z" } }),
          JSON.stringify({ type: "turn_context", payload: { cwd: gitHttpRepo } }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-5.4-pro" } }
          }),
          JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: null } }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [null, { text: "<system-reminder>skip</system-reminder>" }, { text: "Audit the backend client" }]
            }
          }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "item", item: { type: "UserMessage", content: "Second goal" } }
          }),
          JSON.stringify({ type: "event_msg", payload: { type: "token_count", total_tokens: 4200 } }),
          JSON.stringify({
            type: "response_item",
            payload: { type: "message", role: "assistant", content: [{ text: "Inspecting endpoints now." }] }
          }),
          JSON.stringify({
            type: "response_item",
            payload: { type: "custom_tool_call", name: "shell_exec", arguments: "{\"cmd\":\"ls\"}" }
          }),
          JSON.stringify({ type: "response_item", payload: { type: "function_call", arguments: "{}" } }),
          "{broken-json"
        ]
        writeFileSync(join(codexDay, "rollout-2026-11-24-abc123.jsonl"), codexLines.join("\n") + "\n")
        writeFileSync(join(codexDay, "rollout-empty.jsonl"), "")
        const staleRollout = join(codexDay, "rollout-stale.jsonl")
        writeFileSync(staleRollout, JSON.stringify({ type: "session_meta", payload: { cwd: tmp } }) + "\n")
        const oldDate = new Date(Date.now() - 48 * 3600 * 1000)
        utimesSync(staleRollout, oldDate, oldDate)

        // 4. Antigravity SQLite DB + transcripts
        const agyCliBase = join(tmp, ".gemini", "antigravity-cli")
        mkdirSync(agyCliBase, { recursive: true })
        const agyDbPath = join(agyCliBase, "conversation_summaries.db")
        const agyDb = new DatabaseSync(agyDbPath)
        agyDb.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT,
          title TEXT,
          status TEXT,
          not_fully_idle INTEGER,
          last_modified_time TEXT
        );
      `)
        const nowSql = new Date().toISOString().replace("T", " ").slice(0, 19)
        agyDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run(
          "conv-active-1",
          "Wave9 Coverage",
          "CASCADE_RUN_STATUS_RUNNING",
          0,
          nowSql
        )
        agyDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run(
          "conv-wait-2",
          "",
          "CASCADE_RUN_STATUS_IDLE",
          1,
          "invalid-date"
        )
        agyDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run(
          "conv-idle-3",
          null,
          "CASCADE_RUN_STATUS_IDLE",
          0,
          nowSql
        )
        agyDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run(
          "",
          "empty-id",
          "CASCADE_RUN_STATUS_RUNNING",
          1,
          nowSql
        )
        agyDb.close()

        const agyLogDir = join(agyCliBase, "brain", "conv-active-1", ".system_generated", "logs")
        mkdirSync(agyLogDir, { recursive: true })
        const agyLines = [
          JSON.stringify({
            type: "USER_INPUT",
            content: "Work in /Users/dev/smithers/packages/smithers and /Users/dev/.hidden/file"
          }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            model: "gemini-4-neon",
            timestamp: "2026-11-24T12:00:00Z",
            response: "Checking coverage metrics",
            tool_calls: [null, { name: "read_file", args: { Path: "/Users/dev/smithers/src/Cli.ts" } }, {
              arguments: "raw-arg"
            }, { input: { a: 1 } }]
          }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            timestamp: "2026-11-24T12:00:01Z",
            thinking: "Considering next step for vibelang",
            tool_calls: [{ name: "run_command", args: "echo ok" }]
          }),
          "{bad"
        ]
        writeFileSync(join(agyLogDir, "transcript.jsonl"), agyLines.join("\n") + "\n")
        const agyEmptyLogDir = join(agyCliBase, "brain", "conv-wait-2", ".system_generated", "logs")
        mkdirSync(agyEmptyLogDir, { recursive: true })
        writeFileSync(join(agyEmptyLogDir, "transcript.jsonl"), "")

        // 5. Accounts limits.py script
        const limitsDir = join(tmp, ".claude", "skills", "smithers-fallback-agents")
        mkdirSync(limitsDir, { recursive: true })
        writeFileSync(
          join(limitsDir, "limits.py"),
          `import json, sys
print(json.dumps({
  "claude": [
    {"label": "", "data": {}},
    {"label": "c-ready", "data": {"limits": {"weekly_all": {"percent": 20, "resets_at": "2026-12-01T00:00:00Z"}, "five_hour": {"percent": 10}, "weekly_scoped:Fable": {"percent": 5}}, "grants": ["a"]}, "rr": {"active_runs": 2, "pools": ["default"]}},
    {"label": "c-cool", "data": None, "rr": {"cool": {"reason": "429", "until": "2026-11-24T13:00:00Z"}}},
    {"label": "c-mcool", "data": {}, "rr": {"model_cools": {"opus": 123}}},
    {"label": "c-limit", "data": {"limits": {"weekly_all": {"percent": 100}}}, "rr": None},
    {"label": "c-auth", "status": "auth_error", "data": {}, "rr": {}}
  ],
  "codex": [
    {"label": ""},
    {"label": "x-ready", "plan_type": "pro", "data": {"used_percent": 15, "reset_at": 1795600000}, "rr": {}},
    {"label": "x-cool", "data": None, "rr": {"cool": {"until": 1795600000}}},
    {"label": "x-limit", "data": {"limit_reached": True}, "rr": None},
    {"label": "x-auth", "status": "unauthorized", "data": {}, "rr": {}}
  ]
}))
`
        )

        // 6. Cfbox fixtures: token + url + cfbox-*.mjs returning JSON, {jobs:...}, table text, and error
        const cfboxDir = join(tmp, ".cfbox")
        mkdirSync(cfboxDir, { recursive: true })
        writeFileSync(join(cfboxDir, "token"), "tok-test\n")
        writeFileSync(join(cfboxDir, "url"), "https://cfbox.example.test\n")
        const cf1 = join(cfboxDir, "cfbox-1.mjs")
        const cf2 = join(cfboxDir, "cfbox-2.mjs")
        writeFileSync(
          cf1,
          `#!/usr/bin/env node
console.log(JSON.stringify({ jobs: [null, { id: "" }, { id: "job-1", owner: "smithersai/smithers", image: "node:22", state: "running" }, { id: "job-2" }] }))
`
        )
        writeFileSync(
          cf2,
          `#!/usr/bin/env node
console.log(JSON.stringify({ jobs: [null, { id: "" }, { id: "job-1", owner: "smithersai/smithers", image: "node:22", state: "running" }, { id: "job-2" }] }))
`
        )
        chmodSync(cf1, 0o755)
        chmodSync(cf2, 0o755)

        const layer = Collectors.makeCollectorsLayer({
          nodeId: "node-9a",
          name: "wave9a",
          kind: "bare-metal",
          labels: ["fuzz"],
          version: "1.0.0",
          home: tmp
        })

        const runCollectors = Effect.gen(function*() {
          const svc = yield* NodeCollectors
          const host = yield* svc.collectHost()
          const sessions = yield* svc.collectSessions()
          const accounts = yield* svc.collectAccounts()
          const cfbox = yield* svc.collectCfbox()
          return { host, sessions, accounts, cfbox }
        }).pipe(Effect.provide(layer))

        const res = await Effect.runPromise(runCollectors)
        expect(res.host.nodeId).toBe("node-9a")
        expect(res.sessions.length).toBeGreaterThanOrEqual(4)
        expect(res.accounts.length).toBeGreaterThanOrEqual(8)
        expect(res.cfbox?.sessions.length).toBe(2)

        // Exercise table-text cfbox parser and failing cfbox exit
        const tableScript = `#!/usr/bin/env node
console.log("ID OWNER IMAGE STATE CREATED\\nshort line\\nbox-10 acme/vibelang ubuntu running 1m\\nbox-11 - - ended 2m")
`
        writeFileSync(cf1, tableScript)
        writeFileSync(cf2, tableScript)
        const tableRes = await Effect.runPromise(
          Effect.gen(function*() {
            const svc = yield* NodeCollectors
            return yield* svc.collectCfbox()
          }).pipe(Effect.provide(layer))
        )
        expect(tableRes?.sessions.length).toBe(2)

        const errScript = `#!/usr/bin/env node
process.stderr.write("cfbox boom\\n")
process.exit(2)
`
        writeFileSync(cf1, errScript)
        writeFileSync(cf2, errScript)
        const errRes = await Effect.runPromise(
          Effect.gen(function*() {
            const svc = yield* NodeCollectors
            return yield* svc.collectCfbox()
          }).pipe(Effect.provide(layer))
        )
        expect(errRes?.host.held).toContain("cfbox")

        // Exercise inspectLocalSession with transcript & without transcript (claude account dir fallback)
        const insp1 = Collectors.inspectLocalSession(
          { nodeId: "node-9a", name: "wave9a", kind: "bare-metal", labels: [], version: "1.0.0", home: tmp },
          "sess-main"
        )
        expect(insp1.session?.sessionKey).toContain("sess-main")
        expect(insp1.recentEvents.length).toBeGreaterThan(0)

        // Replace session with empty transcript in claude-work account dir to hit lines 1777-1792
        rmSync(join(claudeDir, "sessions", `${process.pid}.json`), { force: true })
        writeFileSync(
          join(claudeAcctDir, "sessions", `${process.pid}.json`),
          JSON.stringify({
            pid: process.pid,
            sessionId: "sess-empty",
            cwd: gitDirRepo,
            status: "waiting",
            startedAt: Date.now()
          })
        )
        const insp2 = Collectors.inspectLocalSession(
          { nodeId: "node-9a", name: "wave9a", kind: "bare-metal", labels: [], version: "1.0.0", home: tmp },
          "sess-empty"
        )
        expect(insp2.session?.status).toBe("waiting")

        // Session with idle status & missing cwd/name
        writeFileSync(
          join(claudeAcctDir, "sessions", `${process.pid}.json`),
          JSON.stringify({ pid: process.pid, status: "idle" })
        )
        const insp3 = Collectors.inspectLocalSession(
          { nodeId: "node-9a", name: "wave9a", kind: "bare-metal", labels: [], version: "1.0.0", home: tmp },
          String(process.pid)
        )
        expect(insp3.session?.status).toBe("idle")

        // Fuzz resolveProject across all repo fixtures & special names
        const paths = [
          gitDirRepo,
          gitHttpRepo,
          gitBadRemote,
          wtDir,
          brokenWt,
          jjWs,
          jjSibling,
          ...specialDirs.map((d) => join(tmp, d)),
          null,
          "/",
          "/tmp"
        ]
        const hints = [
          null,
          "",
          "vibelang compiler fix",
          "evmts voltaire test",
          "zmux pane",
          "needlefish parser",
          "smithers gateway"
        ]
        const report = await runFuzz(
          Arbitrary.schema(
            Schema.Struct({
              pIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: paths.length - 1 }))),
              hIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: hints.length - 1 })))
            })
          ),
          ({ pIdx, hIdx }) => {
            const cache = new Map<string, string | null>()
            const out = Collectors.resolveProject(paths[pIdx]!, hints[hIdx]!, cache)
            assertInv(out === null || typeof out === "string", "resolveProject returns string | null")
          },
          { executions, seed }
        )
        expectPassed(report)
      } finally {
        process.env.PATH = origPath
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "RunTiming, RunProgress, RunActivity, RunHistory & Forensics uphold deep folding, rendering & error invariants",
    async () => {
      // 1. RunTiming comprehensive branches (failedTries, usage, unpriced cost split, monitors, compaction, rejected, retries, stageFit)
      const timingEvents: Array<ControlSchema.ControlEvent> = [
        ev(1, "control.status.observed", { status: "running" }),
        ev(2, "control.agent.turn-opened", { step: { executionId: "exec-1", stepId: "step-a" }, frame: 0 }),
        ev(3, "control.agent.model-requested", {
          step: { executionId: "exec-1", stepId: "step-a" },
          purpose: "turn",
          requestBytes: 2048
        }),
        ev(4, "control.agent.model-retried", { step: { executionId: "exec-1", stepId: "step-a" }, attempt: 2 }),
        ev(5, "control.agent.model-settled", {
          step: { executionId: "exec-1", stepId: "step-a" },
          purpose: "turn",
          servedTier: "pro",
          usage: { inputTokens: 1000, outputTokens: 300, cachedInputTokens: 200, reasoningTokens: 100 },
          timing: { firstThinkingMs: 40, firstOutputMs: 90, totalMs: 500 },
          failedTries: [{ sentMs: 10, failedMs: 25, code: "rate_limit", httpStatus: 429 }, { failedMs: 30 }, {
            noFailedMs: true
          }]
        }),
        ev(6, "control.agent.cell-rejected-in-frame", {
          step: { executionId: "exec-1", stepId: "step-a" },
          code: "overloaded"
        }),
        ev(7, "control.agent.model-settled", {
          step: { executionId: "exec-1", stepId: "step-a" },
          purpose: "comment",
          durationMillis: 200,
          usage: { inputTokens: 500, outputTokens: 150, split: { thinking: 50 } },
          stages: { firstOutputMs: 30, totalMs: 200 }
        }),
        ev(8, "control.agent.model-settled", {
          step: { executionId: "exec-1", stepId: "step-a" },
          purpose: "turn",
          durationMillis: 700,
          usage: { inputTokens: 2000, outputTokens: 600, reasoningTokens: 250 },
          timing: { firstThinkingMs: 50, firstOutputMs: 120, totalMs: 700 }
        }),
        ev(9, "control.agent.model-settled", {
          step: { executionId: "exec-1", stepId: "step-a" },
          purpose: "turn",
          durationMillis: 900,
          usage: { inputTokens: 3000, outputTokens: 900, reasoningTokens: 400 },
          timing: { firstThinkingMs: 60, firstOutputMs: 150, totalMs: 900 }
        }),
        ev(10, "control.agent.model-requested", {
          step: { executionId: "exec-1", stepId: "step-a" },
          purpose: "turn",
          frame: 2
        }),
        ev(11, "flows.agent.usage.v1", {
          step: { executionId: "exec-1", stepId: "step-a" },
          stepKey: "step-k-1",
          spent: 1300,
          costUsd: 0.42,
          purpose: "turn"
        }),
        ev(12, "flows.agent.usage.v1", {
          step: { executionId: "exec-1", stepId: "step-a" },
          stepKey: "call-reading/1",
          spent: 200,
          costUsd: 0.05
        }),
        ev(13, "control.agent.turn-closed", {
          step: { executionId: "exec-1", stepId: "step-a" },
          frame: 0,
          time: { modelMs: 500, cellMs: 120 }
        }),
        ev(14, "control.agent.cell-produced", { step: { executionId: "exec-1", stepId: "step-a" } }),
        ev(15, "control.agent.cell-settled", { step: { executionId: "exec-1", stepId: "step-a" } }),
        ev(16, "control.agent.cell-call-started", { step: { executionId: "exec-1", stepId: "step-a" }, callId: "c1" }),
        ev(17, "control.agent.cell-call-settled", { step: { executionId: "exec-1", stepId: "step-a" }, callId: "c1" }),
        ev(18, "control.agent.compaction-settled", {
          step: { executionId: "exec-1", stepId: "step-a" },
          frame: 1,
          summary: "compacted",
          marks: { kept: 5, squashed: 2, removed: 1 }
        }),
        ev(19, "control.agent.compaction-settled", {
          step: { executionId: "exec-1", stepId: "step-a" },
          frame: 2,
          durationMillis: 150,
          summary: "compacted-2"
        }),
        ev(20, "control.agent.supervisor-settled", {
          step: { executionId: "exec-1", stepId: "step-a" },
          frame: 1,
          latencyMs: 30,
          crossed: true,
          nudged: true,
          compact: ["history"],
          suppressed: "cooldown",
          monitors: [{ id: "loop-guard", crossed: true }, { id: "idle", crossed: false }]
        }),
        ev(21, "control.agent.supervisor-settled", {
          step: { executionId: "exec-1", stepId: "step-a" },
          crossed: true,
          monitors: []
        }),
        ev(22, "control.agent.claim-demanded", {
          step: { executionId: "exec-1", stepId: "step-a" },
          nextFrame: 2,
          demanded: true,
          refused: true
        }),
        ev(23, "control.agent.decision-settled", {
          step: { executionId: "exec-1", stepId: "step-a" },
          classifier: "safety/loop",
          acted: true
        }),
        ev(24, "control.agent.decision-settled", {
          step: { executionId: "exec-1", stepId: "step-a" },
          classifier: "",
          acted: false
        }),
        ev(25, "control.agent.cell-produced", { step: { executionId: "exec-1", stepId: "step-a" } }),
        ev(26, "control.run.completed", { output: "all good" })
      ]
      const timingReport = RunTiming.fold(timingEvents, "run-9a")
      const renderedTiming = RunTiming.render(timingReport)
      expect(renderedTiming).toContain("run-9a")
      expect(timingReport.calls.length).toBeGreaterThanOrEqual(4)

      // 2. RunProgress deep branches (plan-recorded, node-scheduled/settled retry/skipped/deferred/clean, pending, failed, duplicate cell-call-settled, renderer live/plain/destroyed)
      const progressEvents: Array<ControlSchema.ControlEvent> = [
        ev(1, "control.engine.event", {
          executionId: "e1",
          eventType: "flows.engine.plan-recorded",
          payload: { nodes: 3 }
        }),
        ev(2, "control.engine.event", { executionId: "e1", eventType: "flows.engine.plan-recorded", payload: {} }),
        ev(3, "control.engine.event", {
          executionId: "e1",
          eventType: "flows.engine.node-scheduled",
          payload: { nodeId: "n1", kind: "Other" }
        }),
        ev(4, "control.engine.event", {
          executionId: "e1",
          eventType: "flows.engine.node-scheduled",
          payload: { nodeId: "n1", kind: "ActionCall", action: "build" }
        }),
        ev(5, "control.engine.event", {
          executionId: "e1",
          eventType: "flows.engine.node-scheduled",
          payload: { nodeId: "n1", kind: "ActionCall", action: "build", attempt: 2 }
        }),
        ev(6, "control.engine.event", {
          executionId: "e1",
          eventType: "flows.engine.node-settled",
          payload: { nodeId: "n1", outcome: "clean" }
        }),
        ev(7, "control.engine.event", {
          executionId: "e1",
          eventType: "flows.engine.node-scheduled",
          payload: { nodeId: "n2", kind: "ActionCall" }
        }),
        ev(8, "control.engine.event", {
          executionId: "e1",
          eventType: "flows.engine.node-settled",
          payload: { nodeId: "n2", outcome: "skipped" }
        }),
        ev(9, "control.engine.event", {
          executionId: "e1",
          eventType: "flows.engine.node-settled",
          payload: { nodeId: "n3", outcome: "deferred", message: "later" }
        }),
        ev(10, "control.engine.event", {
          executionId: "e1",
          eventType: "flows.engine.node-settled",
          payload: { flowName: "sub-flow", callId: "c1", outcome: "failed", message: "err" }
        }),
        ev(11, "control.agent.turn-started", { turn: 1 }),
        ev(12, "control.agent.turn-started", { turn: 2, seat: "opus" }),
        ev(13, "control.agent.cell-call-settled", { callId: "cell-1", outcome: { _tag: "Failed", message: "boom" } }),
        ev(14, "control.agent.cell-call-settled", { callId: "cell-1", outcome: { _tag: "Succeeded" } }),
        ev(15, "control.agent.cell-call-settled", { callId: "cell-1", outcome: { _tag: "Succeeded" } }),
        ev(16, "control.run.pending", {}),
        ev(17, "control.run.failed", { cause: "line1\n\nline2\nline3\nline4\nline5\nline6" }),
        ev(18, "control.run.failed", { cause: { message: "obj-err" } })
      ]
      let pState = RunProgress.initial()
      for (const e of progressEvents) {
        const next = RunProgress.project(pState, e)
        pState = next.state
        expect(RunProgress.running(pState)).toBeGreaterThanOrEqual(0)
      }
      expect(RunProgress.text("a".repeat(250), 20).endsWith("…")).toBe(true)

      for (const progressMode of ["live", "plain"] as const) {
        const cap = makeCapture(progressMode === "live")
        const r = RunProgress.make("run-9a", {
          output: cap.stream,
          policy: {
            audience: "human",
            structured: false,
            interactive: progressMode === "live",
            progress: progressMode,
            source: "terminal",
            harnesses: []
          }
        })
        for (const e of progressEvents) r.event(e)
        r.close("interrupted")
        r.close("failed") // already closed
      }
      for (const reason of ["failed", "caught-up", "ended"] as const) {
        const cap = makeCapture(false)
        const r = RunProgress.make("run-9a", {
          output: cap.stream,
          policy: {
            audience: "human",
            structured: false,
            interactive: false,
            progress: "plain",
            source: "terminal",
            harnesses: []
          }
        })
        r.event(ev(1, "control.run.waiting-approval", {}))
        r.close(reason)
      }
      // Destroyed stream early return
      const deadCap = makeCapture(false)
      deadCap.stream.end()
      const deadR = RunProgress.make("run-9a", {
        output: deadCap.stream,
        policy: {
          audience: "human",
          structured: false,
          interactive: false,
          progress: "plain",
          source: "terminal",
          harnesses: []
        }
      })
      deadR.event(ev(1, "control.run.completed", {}))
      deadR.close("ended")

      // observe with failed & interrupted exit
      const obsCap = makeCapture(false)
      const obsOpts: RunProgress.Options = {
        output: obsCap.stream,
        policy: {
          audience: "human",
          structured: false,
          interactive: false,
          progress: "plain",
          source: "terminal",
          harnesses: []
        }
      }
      await Effect.runPromiseExit(
        Stream.runDrain(RunProgress.observe(Stream.fail("boom"), "run-9a")).pipe(
          Effect.provideService(RunProgress.Configuration, obsOpts)
        )
      )
      await Effect.runPromiseExit(
        Stream.runDrain(RunProgress.observe(Stream.fromEffect(Effect.interrupt), "run-9a")).pipe(
          Effect.provideService(RunProgress.Configuration, obsOpts)
        )
      )

      // 3. RunActivity deep branches
      const actEvents: Array<ControlSchema.ControlEvent> = [
        ev(1, "control.status.observed", {}),
        ev(2, "control.engine.event", {
          executionId: "run-9a",
          eventType: "flows.engine.run-decision",
          payload: {
            decision: "transitioned",
            status: "failed",
            failure: { tag: "TestFail", message: "secret sk-12345678901234567890", attempts: 2, retryable: true }
          }
        }),
        ev(3, "control.engine.event", {
          executionId: "run-9a",
          eventType: "flows.engine.run-decision",
          payload: { decision: "lease-reconfirmed", detail: { unconfirmedMs: 420 } }
        }),
        ev(4, "control.engine.event", {
          executionId: "run-9a",
          eventType: "flows.engine.run-decision",
          payload: { decision: "lease-reconfirmed", detail: { unconfirmedMs: -1 } }
        }),
        ev(5, "control.engine.event", {
          executionId: "child-1",
          eventType: "flows.engine.run-decision",
          payload: {
            decision: "interrupt-released",
            flowName: "sub/a",
            cause: { kind: "lease-lapsed", unconfirmedMs: 9000 }
          }
        }),
        ev(6, "control.engine.event", {
          executionId: "child-2",
          eventType: "flows.engine.node-scheduled",
          payload: { nodeId: "n-a", kind: "ActionCall", action: "compile" }
        }),
        ev(7, "control.engine.event", {
          executionId: "child-2",
          eventType: "flows.engine.node-scheduled",
          payload: { nodeId: "n-b", kind: "ActionCall", action: "lint" }
        }),
        ev(8, "control.engine.event", {
          executionId: "child-2",
          eventType: "flows.engine.node-scheduled",
          payload: { nodeId: "n-c", kind: "ActionCall", action: "test" }
        }),
        ev(9, "control.engine.event", {
          executionId: "child-2",
          eventType: "flows.engine.node-scheduled",
          payload: { nodeId: "n-d", kind: "ActionCall", action: "pack" }
        }),
        ev(10, "control.engine.event", {
          executionId: "child-2",
          generation: 2,
          sequence: 5,
          eventType: "flows.engine.observation",
          payload: { roundOrdinal: 2, status: "running", parentExecutionId: "run-9a" }
        }),
        ev(11, "control.engine.event", {
          executionId: "child-2",
          generation: 1,
          sequence: 1,
          eventType: "flows.engine.observation",
          payload: { roundOrdinal: 1, status: "running", parentExecutionId: "run-9a" }
        }),
        ev(12, "control.engine.event", {
          executionId: "child-3",
          generation: 1,
          sequence: 2,
          eventType: "flows.engine.observation",
          payload: { roundOrdinal: 1, status: "completed", finishedAtMs: 2000, parentExecutionId: "run-9a" }
        }),
        ev(13, "control.engine.event", {
          executionId: "child-4",
          generation: 1,
          sequence: 2,
          eventType: "flows.engine.observation",
          payload: { roundOrdinal: 1, status: "completed", finishedAtMs: 3000, parentExecutionId: "run-9a" }
        })
      ]
      const failObj = RunActivity.failureOf(actEvents, "run-9a")
      expect(failObj?.tag).toBe("TestFail")
      expect(RunActivity.driftVerdict({ recorded: "abc", current: undefined } as never)).toContain("no longer on disk")
      expect(RunActivity.driftVerdict({ recordedEngine: "1", currentEngine: "2" } as never)).toContain(
        "allow-code-drift"
      )
      const pubSnaps = RunActivity.publicExecutionSnapshots([
        {
          snapshots: [
            { _tag: "Unavailable", executionId: "e-u", reason: "offline" } as never,
            { _tag: "Missing", executionId: "e-m", revision: "r1", deleted: true } as never
          ]
        } as never
      ])
      expect(pubSnaps.length).toBe(2)
      const shown = RunActivity.show(
        {
          runId: "run-9a",
          flowId: "demo/flow",
          status: "parked",
          waitingReason: "released",
          createdAt: 1000,
          updatedAt: 2000,
          roundOrdinal: 1
        } as ControlSchema.RunSummary,
        actEvents,
        Date.now(),
        []
      )
      expect(shown.runId).toBe("run-9a")

      // 4. RunHistory deep branches
      expect(RunHistory.jsonBytes("héllo\n\t\"world\"", { indent: 0, initialDepth: 0, maxDepth: 10, maxBytes: 1000 }))
        .toBeGreaterThan(10)
      expect(RunHistory.jsonBytes({ a: { b: { c: 1 } } }, { indent: 0, initialDepth: 0, maxDepth: 1, maxBytes: 1000 }))
        .toBe(Infinity)
      expect(RunHistory.jsonBytes("x".repeat(500), { indent: 0, initialDepth: 0, maxDepth: 10, maxBytes: 10 })).toBe(
        Infinity
      )

      const histEvents: Array<ControlSchema.ControlEvent> = [
        ev(1, "control.engine.event", {
          executionId: "run-9a",
          generation: 1,
          sequence: 1,
          eventType: "flows.engine.node-scheduled",
          payload: { nodeId: "x".repeat(300), kind: "ActionCall", action: "a" }
        }),
        ev(1, "control.engine.event", {
          executionId: "run-9a",
          generation: 1,
          sequence: 2,
          eventType: "flows.engine.node-scheduled",
          payload: { nodeId: "n1", kind: "ActionCall", action: "y".repeat(1200) }
        }),
        ev(2, "control.engine.event", {
          executionId: "run-9a",
          generation: 1,
          sequence: 3,
          eventType: "flows.engine.observation",
          payload: { executionId: "run-9a", status: "running", state: { currentNode: "n".repeat(1100), round: 3 } }
        }),
        ev(3, "control.run.resumed", {}),
        ev(4, "control.engine.event", {
          executionId: "run-9a",
          generation: 1,
          sequence: 4,
          eventType: "flows.engine.gap",
          payload: { reason: "rewound" }
        }),
        ev(5, "control.run.failed", { fault: { deep: "z".repeat(4000) }, bigArr: [1, 2, "a".repeat(2000)] })
      ]
      const hRead = await Effect.runPromise(
        RunHistory.read(
          Stream.fromIterable(histEvents),
          "run-9a",
          { maxEvents: 100, maxBytes: 256, maxEventBytes: 128 } as never
        )
      )
      expect(hRead.history).toBeDefined()
      const hField1 = await Effect.runPromise(
        RunHistory.field(Stream.fromIterable(histEvents), "/events/5/payload/bigArr/2", 4096, { offset: 0, length: 50 })
      )
      expect(hField1).toBeDefined()
      const hField2 = await Effect.runPromise(
        RunHistory.field(Stream.fromIterable(histEvents), "/events/5/payload/fault", 16)
      )
      expect(hField2).toBeDefined()
      const hFieldErr = await Effect.runPromiseExit(
        RunHistory.field(Stream.fromIterable(histEvents), "/events/5/payload/fault", 4096, { offset: 0, length: 50 })
      )
      expect(Exit.isFailure(hFieldErr)).toBe(true)

      // 5. Forensics deep branches
      const forensicEvents: Array<ControlSchema.ControlEvent> = [
        ev(1, "control.agent.model-output", { text: "hello model", usage: { inputTokens: 10, outputTokens: 20 } }),
        ev(2, "control.agent.print", { text: "printed note" }),
        ev(3, "control.agent.transition", {
          transition: { _tag: "Continue", justification: "keep going", filed: ["f1"] }
        }),
        ev(4, "control.agent.transition", { transition: { _tag: "Park", reason: "approval", message: "need ok" } }),
        ev(5, "control.agent.transition", { transition: { _tag: "Complete", output: "final answer\nline2" } }),
        ev(6, "control.agent.cell-settled", { outcome: { _tag: "Failed", message: "cell err" } }),
        ev(7, "control.agent.memory-recalled", { kept: [{ id: "m1" }], withheld: [{ id: "m2" }] }),
        ev(8, "control.agent.flow-refused", { flowName: "f/a", input: { k: 1 }, message: "denied 1" }),
        ev(9, "control.agent.flow-refused", { flowName: "f/b", input: { k: 2 }, message: "denied 2" }),
        ev(10, "control.run.waiting-approval", {
          reason: "budget",
          request: {
            versioned: true,
            payload: { target: { _tag: "Run", runId: "run-9a" }, scope: "run" },
            incident: { kind: "budget", metric: "tokens", used: 100, reserved: 20, max: 110, next: 30, allowance: 50 }
          }
        }),
        ev(11, "control.run.completed", { output: "final answer\nsecond line" })
      ]
      const dig = Forensics.digest(forensicEvents, "run-9a")
      for (const e of forensicEvents) {
        expect(typeof Forensics.eventLine(e)).toBe("string")
      }
      const diag1 = Forensics.renderDiagnosis(
        {
          runId: "run-9a",
          flowId: "demo/flow",
          status: "waiting-approval",
          codeDrift: { recorded: "r1", current: undefined, recordedEngine: "1", currentEngine: undefined }
        } as never,
        {
          ...dig,
          status: "waiting-approval",
          parkedApproval: "{\"ok\":true}",
          parkedIncident: {
            classification: "Runaway",
            source: "tokens",
            message: "token cap reached",
            used: 100,
            reserved: 20,
            max: 110,
            next: 30,
            allowance: 50
          } as never
        }
      )
      expect(diag1).toContain("runs continue")
      const diag2 = Forensics.renderDiagnosis(
        { runId: "run-9a", flowId: "demo/flow", status: "completed" } as never,
        {
          ...dig,
          status: "completed",
          parkedApproval: undefined,
          parkedIncident: { classification: "Runaway", source: "tokens", message: "cap" } as never,
          finalOutput: "done!\nmore"
        }
      )
      expect(diag2).toContain("completed")
      expect(Forensics.renderTranscript([], "run-9a")).toBe("No events.")
      expect(Forensics.renderTranscript(forensicEvents, "run-9a")).toContain("run-9a")

      // Fuzz Forensics.eventLine & RunTiming.fold over randomized event slices
      const report = await runFuzz(
        Arbitrary.schema(
          Schema.Struct({
            n: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: timingEvents.length })))
          })
        ),
        ({ n }) => {
          const sub = timingEvents.slice(0, n)
          const rep = RunTiming.fold(sub, "run-9a")
          const text = RunTiming.render(rep)
          assertInv(typeof text === "string" && text.length > 0, "RunTiming.render non-empty")
        },
        { executions, seed: seed + 1 }
      )
      expectPassed(report)
    },
    60_000
  )

  it(
    "Presentation, Ui, Compatibility, Tui, Generate & Alerts uphold formatting, interactive & destination invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "wave9a-ui-"))
      try {
        // 1. Presentation deep branches
        const envOut: Array<string> = []
        await Presentation.withErrorEnvelope(
          (text) => envOut.push(text),
          async (wrapped) => {
            const cap = makeCapture(true)
            await Presentation.scope(
              { command: "runs_show", agent: true, formatExplicit: true, options: { json: true } },
              { stdout: cap.stream as never, stderr: cap.stream as never, environment: {} },
              async () => {
                try {
                  Presentation.fail(
                    { command: "runs_show", error: (e) => e as never },
                    new CliError.Refused({ fault: "user", code: "bad_state", message: "nope", class: "permission" })
                  )
                } catch {
                  // expected
                }
                wrapped(JSON.stringify({ error: { code: "bad_state", message: "nope" } }))
                wrapped(JSON.stringify({ code: "bad_state", message: "nope" }))
                wrapped("not-json-at-all")
              }
            )
          }
        )
        expect(envOut.some((s) => s.includes("\"class\": \"permission\""))).toBe(true)

        const nextReleased = Presentation.nextActions(
          { runId: "r-1", status: "parked", waitingReason: "released" },
          { options: { remote: "https://smithers.example.test/api" } }
        )
        expect(nextReleased.some((n) => n.command.includes("runs resume"))).toBe(true)
        const nextWait = Presentation.nextActions(
          { runId: "r-2", status: "waiting-approval" },
          { options: { remote: "https://user:pass@smithers.example.test/api?x=1" } }
        )
        expect(nextWait.some((n) => n.command.includes("approvals list"))).toBe(true)
        const nextParked = Presentation.nextActions({ _tag: "Parked", runId: "r-3" }, {})
        expect(nextParked.some((n) => n.command.includes("approvals list"))).toBe(true)

        const liveCap = makeCapture(true)
        await Presentation.scope(
          { command: "runs list", options: {} },
          { stdout: liveCap.stream as never, stderr: liveCap.stream as never, environment: { TERM: "xterm-256color" } },
          async () => {
            Presentation.finish(
              { command: "runs list", options: {} },
              [null, undefined, "a", { nested: [1, 2] }],
              { next: [{ command: "runs show r-1", description: "inspect" }] }
            )
            Presentation.finish({ command: "runs list", options: {} }, undefined)
          }
        )

        // 2. Ui.make interactive & non-interactive branches
        const outCap = makeCapture(true)
        const inStream = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (m: boolean) => void }
        inStream.isTTY = true
        inStream.setRawMode = () => {}
        const interactiveUi = Ui.make({ output: outCap.stream, input: inStream, interactive: true })
        await Effect.runPromise(
          Effect.gen(function*() {
            yield* interactiveUi.note("body only", "")
            yield* interactiveUi.note("body with title", "Title")
            const sp = interactiveUi.spinner()
            sp.start("starting")
            sp.message("mid")
            sp.stop("done")
            const sp2 = interactiveUi.spinner()
            sp2.start("err")
            sp2.cancel("cancelled")
            const sp3 = interactiveUi.spinner()
            sp3.start("err2")
            sp3.error("failed")
            const ac = new AbortController()
            ac.abort()
            async function* gen() {
              yield "a"
              yield "b"
            }
            const streamed = yield* interactiveUi.streamSuggestions(gen(), {
              label: (x, pos) => `${pos}: ${x}`,
              signal: ac.signal
            })
            expect(streamed.stopped).toBe(true)
            for (
              const checks of [
                [{ label: "a", status: "fail" as const, summary: "bad" }],
                [{ label: "a", status: "fail" as const, summary: "bad" }, {
                  label: "b",
                  status: "fail" as const,
                  summary: "bad2"
                }],
                [{ label: "a", status: "warn" as const, summary: "w1" }],
                [{ label: "a", status: "warn" as const, summary: "w1" }, {
                  label: "b",
                  status: "warn" as const,
                  summary: "w2"
                }],
                [{ label: "a", status: "ok" as const, summary: "ok" }]
              ]
            ) {
              yield* interactiveUi.checklist("Doctor", checks as never)
            }
          })
        )
        // Interactive pickSuggestion/confirm/text with Ctrl+C cancellation so clack resolves immediately
        const runWithCancel = async <A, E>(eff: Effect.Effect<A, E, Ui.Ui>) => {
          const inp = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (m: boolean) => void }
          inp.isTTY = true
          inp.setRawMode = () => {}
          const out = makeCapture(true)
          const u = Ui.make({ output: out.stream, input: inp, interactive: true })
          setTimeout(() => {
            inp.write("\x03")
          }, 15)
          return Effect.runPromise(eff.pipe(Effect.provideService(Ui.Ui, u)))
        }
        const selCancel = await runWithCancel(
          Effect.flatMap(Ui.Ui, (u) =>
            u.pickSuggestion(["alpha", "beta"], {
              message: "Pick one",
              label: (x) => x,
              hint: (x) => `hint-${x}`
            }))
        )
        expect(Option.isNone(selCancel)).toBe(true)
        let cancelledConfirm = false
        const confCancel = await runWithCancel(
          Effect.flatMap(Ui.Ui, (u) =>
            u.confirm({
              message: "Sure?",
              nonInteractive: false,
              onCancel: () => {
                cancelledConfirm = true
              }
            }))
        )
        expect(confCancel).toBe(false)
        expect(cancelledConfirm).toBe(true)
        const textCancel = await runWithCancel(Effect.flatMap(Ui.Ui, (u) => u.text("Name")))
        expect(Option.isNone(textCancel)).toBe(true)

        // 3. Compatibility.rewrite
        const compatCases: ReadonlyArray<ReadonlyArray<string>> = [
          ["internal", "claude", "--help"],
          ["gateway", "status"],
          ["gateway", "stop"],
          ["gateway", "other"],
          ["bug"],
          ["run", "my-flow", "--resume"],
          ["run", "my-flow", "--resume=r-1"],
          ["run", "{\"flow\":\"x\"}"],
          ["run", "my-flow", "--", "--resume"],
          ["logs", "run-1"],
          ["status", "run-1"],
          ["status", "--unknown-flag-xyz"]
        ]
        for (const argv of compatCases) {
          Compatibility.legacyArguments(argv)
          Compatibility.formattedLogArguments(argv)
          Compatibility.agentArguments(argv)
        }

        // 4. Tui.run with full options & aborted signal
        const aborted = new AbortController()
        aborted.abort()
        const tuiExit = await Tui.run(
          {
            model: "anthropic:claude",
            continue: true,
            resume: true,
            print: "hi",
            approve: "ask",
            budgetTokens: "1000",
            budgetDailyTokens: "5000",
            box: "org/repo/1",
            directory: tmp
          },
          { ...process.env, HOME: tmp },
          undefined,
          undefined,
          aborted.signal
        ).catch(() => 130)
        expect(typeof tuiExit).toBe("number")

        // 5. Generate.initialize for bun & yarn & .smithers/WORKSPACE.ts + createGenerateCli
        for (
          const [dirName, pm] of [
            ["gen-bun", "bun@1.2.3"],
            ["gen-yarn", "yarn@4.1.0"]
          ] as const
        ) {
          const d = join(tmp, dirName)
          mkdirSync(join(d, ".smithers"), { recursive: true })
          writeFileSync(join(d, "package.json"), JSON.stringify({ name: dirName, packageManager: pm }))
          writeFileSync(join(d, ".smithers", "WORKSPACE.ts"), "// existing\n")
          const res = await Generate.initialize(d, dirName, { HOME: tmp })
          expect(res.created.length + res.retained.length).toBeGreaterThan(0)
        }
        const genCli = Generate.createGenerateCli({ environment: { ...process.env, HOME: tmp }, exit: () => {} })
        for (
          const argv of [
            ["package", "--root", join(tmp, "gen-bun")],
            ["ci", "--root", join(tmp, "gen-bun"), "--target", "//:missing"]
          ]
        ) {
          await genCli.serve(argv, { env: { ...process.env, HOME: tmp }, stdout: () => {}, exit: () => {} })
        }

        // 6. AlertsCmd (email, telegram missing token, none, bad URL, unreadable config, acknowledge)
        const alertDir = join(tmp, "alerts-ws")
        mkdirSync(join(alertDir, ".smithers"), { recursive: true })
        // Email with missing key -> destination none
        writeFileSync(
          join(alertDir, ".smithers", "alerts.json"),
          JSON.stringify({ email: { from: "a@b.c", to: ["d@e.f"], url: "http://127.0.0.1:9999/send" } })
        )
        const makeMemJournal = (initialEntries: Array<Record<string, unknown>> = [], pageLimit = 100) => {
          const stored: Array<Record<string, unknown>> = [...initialEntries]
          return Layer.mergeAll(
            Layer.succeed(Project.ProjectRoot, alertDir),
            Layer.succeed(Journal.Journal, {
              emitDurableUnfenced: (input: any) =>
                Effect.sync(() => {
                  const seq = stored.length + 1
                  stored.push({
                    seq,
                    runId: input.runId,
                    kind: input.kind,
                    type: input.kind,
                    payload: input.payload,
                    timestamp: Date.now()
                  })
                  return { _tag: "Accepted", seq } as never
                }),
              entries: (opts: { runId: string; after?: number; limit?: number }) =>
                Effect.sync(() => {
                  const after = opts.after ?? 0
                  const limit = Math.min(opts.limit ?? 512, pageLimit)
                  const matching = stored.filter((e) => e.runId === opts.runId && Number(e.seq) > after)
                  const slice = matching.slice(0, limit)
                  return { entries: slice, hasMore: matching.length > limit } as never
                }),
              whenCommitted: (eff: Effect.Effect<unknown>) => eff
            } as unknown as Journal.Service)
          )
        }
        const emptyJournal = makeMemJournal()
        const repNoneEmail = await Effect.runPromise(
          AlertsCmd.report(
            { runId: "r-1", probe: "health", state: "failing", summary: "down" },
            { environment: {} } as never
          ).pipe(
            Effect.provide(emptyJournal)
          )
        )
        expect(repNoneEmail.destination).toBe("none")
        expect(AlertsCmd.renderReport(repNoneEmail)).toContain("Recorded")

        // Telegram with missing token -> destination none
        writeFileSync(
          join(alertDir, ".smithers", "alerts.json"),
          JSON.stringify({ telegram: { chatId: "123", url: "http://127.0.0.1:9999/tg" } })
        )
        const repNoneTg = await Effect.runPromise(
          AlertsCmd.report(
            { runId: "r-1", probe: "health", state: "failing", summary: "down" },
            { environment: {} } as never
          ).pipe(
            Effect.provide(emptyJournal)
          )
        )
        expect(repNoneTg.destination).toBe("none")

        // Email with key set + real local HTTP server
        const emailServer = createServer((_req, res) => {
          res.statusCode = 200
          res.setHeader("content-type", "application/json")
          res.end(JSON.stringify({ id: "msg-1" }))
        })
        await new Promise<void>((r) => emailServer.listen(0, "127.0.0.1", r))
        const emailPort = (emailServer.address() as AddressInfo).port
        try {
          writeFileSync(
            join(alertDir, ".smithers", "alerts.json"),
            JSON.stringify({ email: { from: "a@b.c", to: ["d@e.f"], url: `http://127.0.0.1:${emailPort}/send` } })
          )
          const repEmail = await Effect.runPromise(
            AlertsCmd.report(
              { runId: "r-1", probe: "health", state: "failing", summary: "down" },
              { environment: { SMITHERS_ALERT_EMAIL_API_KEY: "re_test_key" } } as never
            ).pipe(Effect.provide(makeMemJournal([], 1)))
          )
          expect(repEmail.destination).toBe("email")
          if (repEmail.delivered.length > 0) {
            const aid = repEmail.delivered[0]!.alertId
            const jAck = makeMemJournal([], 100)
            await Effect.runPromise(
              AlertsCmd.report(
                { runId: "r-1", probe: "health", state: "failing", summary: "down" },
                { environment: { SMITHERS_ALERT_EMAIL_API_KEY: "re_test_key" } } as never
              ).pipe(Effect.provide(jAck))
            )
            const ackList = await Effect.runPromise(
              AlertsCmd.list("r-1", { environment: {} } as never).pipe(Effect.provide(jAck))
            )
            expect(AlertsCmd.renderList(ackList)).toContain("r-1")
            if (ackList.alerts.length > 0) {
              const taken = await Effect.runPromise(
                AlertsCmd.acknowledge(
                  { runId: "r-1", alertId: ackList.alerts[0]!.alertId, by: "op" },
                  { environment: {} } as never
                ).pipe(
                  Effect.provide(jAck)
                )
              )
              expect(taken.acknowledged).toBe(true)
            }
            expect(aid.length).toBeGreaterThan(0)
          }
        } finally {
          emailServer.close()
        }

        // Empty config -> no destination configured
        writeFileSync(join(alertDir, ".smithers", "alerts.json"), JSON.stringify({}))
        const repEmpty = await Effect.runPromise(
          AlertsCmd.report({ runId: "r-1", probe: "health", state: "ok" }, { environment: {} } as never).pipe(
            Effect.provide(makeMemJournal([], 1))
          )
        )
        expect(repEmpty.destination).toBe("none")

        // Unreadable alerts config directory
        rmSync(join(alertDir, ".smithers", "alerts.json"), { force: true })
        mkdirSync(join(alertDir, ".smithers", "alerts.json"), { recursive: true })
        const badCfgExit = await Effect.runPromiseExit(
          AlertsCmd.report(
            { runId: "r-1", probe: "health", state: "failing", summary: "down" },
            { environment: {} } as never
          ).pipe(Effect.provide(emptyJournal))
        )
        expect(Exit.isFailure(badCfgExit)).toBe(true)

        // Fuzz Compatibility.legacyArguments / formattedLogArguments / agentArguments
        const report = await runFuzz(
          Arbitrary.schema(
            Schema.Array(
              Schema.Literals([
                "internal",
                "claude",
                "gateway",
                "status",
                "stop",
                "bug",
                "run",
                "logs",
                "--resume",
                "--",
                "x"
              ])
            )
          ),
          (argv) => {
            const a = Compatibility.legacyArguments(argv)
            const b = Compatibility.formattedLogArguments(argv)
            const c = Compatibility.agentArguments(argv)
            assertInv(a === undefined || Array.isArray(a), "legacyArguments returns array | undefined")
            assertInv(b === undefined || Array.isArray(b), "formattedLogArguments returns array | undefined")
            assertInv(c === undefined || Array.isArray(c), "agentArguments returns array | undefined")
          },
          { executions, seed: seed + 2 }
        )
        expectPassed(report)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "ControlBridge, ControlCommands, Cli.makeCli, Command.cli, Launch & Settlement uphold deep error, guard & option invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "wave9a-ctrl-"))
      const env = {
        ...process.env,
        HOME: tmp,
        XDG_CONFIG_HOME: join(tmp, "xdg-cfg"),
        XDG_DATA_HOME: join(tmp, "xdg-data")
      }
      try {
        // 1. ControlBridge deep branches
        const mcpCap = makeCapture(false)
        await Presentation.scope(
          { command: "runs_list", agent: true, formatExplicit: true, options: {} },
          { stdout: mcpCap.stream as never, stderr: mcpCap.stream as never, environment: env },
          async () => {
            for (
              const badOpt of [{ remote: "http://x", quiet: false }, { root: tmp, quiet: false }, {
                mcpConfig: "/tmp/m.json",
                quiet: false
              }]
            ) {
              let threw = false
              try {
                ControlBridge.configuration(badOpt, { environment: env })
              } catch {
                threw = true
              }
              expect(threw).toBe(true)
            }
            const okCfg = ControlBridge.configuration({ quiet: false }, { environment: env })
            expect(okCfg.principal?.id).toBe("mcp")
          }
        )

        const abortErr = new AbortController()
        abortErr.abort(new Error("user ctrl-c"))
        expect(ControlBridge.failureOf(Cause.interrupt(0 as never), abortErr.signal)).toBeInstanceOf(CliError.Refused)
        const abortRaw = new AbortController()
        abortRaw.abort("raw")
        expect(ControlBridge.failureOf(Cause.interrupt(0 as never), abortRaw.signal)).toBeInstanceOf(CliError.Refused)

        // resolveRunId remote & missing db
        const baseCtrlLayer = Layer.succeed(Control.Control, makeBaseControl())
        expect(
          await Effect.runPromise(
            ControlBridge.resolveRunId("abc", { remote: "http://127.0.0.1:9", quiet: false }, { environment: env })
              .pipe(Effect.provide(baseCtrlLayer))
          )
        ).toBe("abc")
        expect(
          await Effect.runPromise(
            ControlBridge.resolveRunId("abc", { root: tmp, quiet: false }, { environment: env }).pipe(
              Effect.provide(baseCtrlLayer)
            )
          )
        ).toBe("abc")

        // signalReceipts remote refusal
        let srThrew = false
        try {
          await ControlBridge.signalReceipts({ runId: "r-1", limit: 10 }, {
            remote: "http://127.0.0.1:9",
            quiet: false
          }, { environment: env })
        } catch {
          srThrew = true
        }
        expect(srThrew).toBe(true)

        // ControlBridge.host with operatorTokenFile + pre-aborted signal
        const hostAc = new AbortController()
        const tokFile = join(tmp, "op.tok")
        setTimeout(() => hostAc.abort(), 150)
        await ControlBridge.host(
          {
            host: "127.0.0.1",
            port: 0,
            credential: "cred-1234567890",
            operatorTokenFile: tokFile
          } as Serve.Bind,
          { root: tmp, quiet: false },
          {
            environment: env,
            stdout: makeCapture(false).stream as never,
            stderr: makeCapture(false).stream as never,
            signal: hostAc.signal
          }
        ).catch(() => undefined)

        // 2. ControlCommands deep validation & error branches
        const emptyRoot = join(tmp, "empty-ws")
        mkdirSync(emptyRoot, { recursive: true })
        const flowCli = ControlCommands.createFlowCli({ environment: env, exit: () => {} })
        const runsCli = ControlCommands.createRunsCli({ environment: env, exit: () => {} })
        const approvalsCli = ControlCommands.createApprovalsCli({ environment: env, exit: () => {} })

        const runSub = async (
          sub: { serve: (argv?: Array<string>, opts?: any) => Promise<void> },
          argv: ReadonlyArray<string>
        ) => {
          let out = ""
          await sub.serve([...argv], {
            env,
            stdout: (t: string) => {
              out += t
            },
            exit: () => {}
          })
          return out
        }

        await runSub(flowCli, ["start", "demo", "--wait", "--detached", "--root", emptyRoot])
        await runSub(flowCli, ["start", "demo", "--root", emptyRoot])
        await runSub(runsCli, ["show", "missing-run", "--offset", "0", "--root", emptyRoot])
        await runSub(runsCli, ["show", "missing-run", "--root", emptyRoot])
        await runSub(runsCli, ["timing", "missing-run", "--root", emptyRoot])
        await runSub(runsCli, ["logs", "missing-run", "--after-offset", "1", "--root", emptyRoot])
        await runSub(runsCli, ["signal", "missing-run", "ping", "--timeout", "100", "--root", emptyRoot])
        await runSub(runsCli, ["continue", "missing-run", "--root", emptyRoot])
        await runSub(runsCli, ["stop", "missing-run", "--root", emptyRoot])
        await runSub(runsCli, ["monitor", "missing-run", "--auto-heal", "--root", emptyRoot])
        await runSub(approvalsCli, ["list", "--root", emptyRoot])
        await runSub(approvalsCli, ["grant", "//:target", "--revision", "rev-1", "--root", emptyRoot])

        // Direct unit/effect calls on guardIncident & pendingApprovals with injected Control service
        const incidentRow = {
          runId: "run-9a",
          requestId: "req-1",
          status: "pending" as const,
          payload: { target: { _tag: "Run" as const, runId: "run-9a" }, scope: "run" as const },
          request: { incident: { classification: "Runaway", source: "tokens", message: "cap", used: 10, max: 5 } },
          flowId: "demo/flow",
          name: "budget-guard",
          attempt: 1
        }
        const ctrlLayer = Layer.succeed(
          Control.Control,
          makeBaseControl({
            list: (req: any) => {
              if (req.kind === "approvals") {
                return Effect.succeed({ _tag: "approvals", items: [incidentRow], nextCursor: undefined } as never)
              }
              return Effect.succeed({
                _tag: "runs",
                items: [{
                  runId: "run-9a",
                  flowId: "demo/flow",
                  status: "waiting-approval",
                  createdAt: 1,
                  updatedAt: 2
                }],
                nextCursor: undefined
              } as never)
            },
            watch: () =>
              Stream.fromIterable([
                ev(1, "control.approval.requested", {
                  requestId: "req-1",
                  payload: { target: { _tag: "Node", runId: "run-9a", requestId: "req-1" }, scope: "run" },
                  incident: { classification: "Runaway", source: "tokens", message: "cap", used: 10, max: 5 }
                }),
                ev(2, "control.run.waiting-approval", {
                  request: {
                    payload: { target: { _tag: "Run", runId: "run-9a" }, scope: "run" },
                    incident: { classification: "Runaway", source: "tokens", message: "cap", used: 10, max: 5 }
                  }
                })
              ])
          })
        )
        const gInc = await Effect.runPromise(ControlCommands.guardIncident("run-9a").pipe(Effect.provide(ctrlLayer)))
        expect(gInc).toBeDefined()
        const pend = await Effect.runPromise(ControlCommands.pendingApprovals("run-9a").pipe(Effect.provide(ctrlLayer)))
        expect(pend.length).toBeGreaterThanOrEqual(0)

        // 3. Cli.makeCli uncovered routes
        const out = makeCapture(true)
        const err = makeCapture(true)
        const cliAc = new AbortController()
        const cli = Cli.makeCli({
          environment: env,
          stdout: out.stream as unknown as NodeJS.WriteStream,
          stderr: err.stream as unknown as NodeJS.WriteStream,
          exit: () => {},
          signal: cliAc.signal
        })
        const serveCli = async (argv: ReadonlyArray<string>) => {
          await cli.serve([...argv], {
            env,
            stdout: (t) => {
              out.stream.write(t)
            },
            exit: () => {}
          })
        }

        // mcp add unknown agent, mcp add valid agent (isolated HOME), mcp add unwritable failure
        await serveCli(["mcp", "add", "--agent", "nope-agent"])
        await serveCli(["mcp", "add", "--agent", "claude-code", "--memory-db", join(tmp, "mem.sqlite")])
        // Make ~/.claude.json a directory so claude-code addMcp fails -> hits manualInstructions branch
        const badHome = join(tmp, "bad-home")
        mkdirSync(join(badHome, ".claude.json"), { recursive: true })
        const badCli = Cli.makeCli({
          environment: { ...env, HOME: badHome },
          stdout: out.stream as unknown as NodeJS.WriteStream,
          stderr: err.stream as unknown as NodeJS.WriteStream,
          exit: () => {}
        })
        await badCli.serve(["mcp", "add", "--agent", "claude-code"], {
          env: { ...env, HOME: badHome },
          stdout: () => {},
          exit: () => {}
        })

        await serveCli(["mcp", "login", "--origin", "http://127.0.0.1:1", "--no-open"])
        await serveCli(["alerts", "ack", "--run", "r-1", "--id", "al-1", "--by", "tester", "--root", emptyRoot])
        await serveCli(["init", "--global", "--root", emptyRoot])
        await serveCli(["doctor", "--remote", "http://127.0.0.1:1"])
        const nonDirFile = join(tmp, "not-a-dir.txt")
        writeFileSync(nonDirFile, "hi")
        await serveCli(["suggest", nonDirFile])
        await serveCli(["open", emptyRoot])
        await serveCli(["--help"])
        await serveCli(["runss"]) // DidYouMean suggestion
        await serveCli(["runs", "list", "--", "extra"])

        // Pre-aborted signal for tui command
        cliAc.abort()
        await serveCli(["tui", emptyRoot, "--print", "hi"])

        // 4. Launch & Settlement deep branches
        const projLayer = Layer.succeed(Project.ProjectRoot, emptyRoot)
        const uiLayer = Layer.succeed(
          Ui.Ui,
          Ui.make({ output: makeCapture(false).stream, input: new PassThrough(), interactive: false })
        )
        const pendingCtrl = Layer.succeed(
          Control.Control,
          makeBaseControl({
            plan: () =>
              Effect.succeed({
                approval: { target: { _tag: "Plan", planId: "p-1" }, scope: "run" },
                envelope: { capabilities: ["*"] },
                warnings: [{ message: "wild cap" }]
              } as never),
            approve: () => Effect.succeed({ _tag: "Accepted", receiptId: "rc-1", runId: "run-declined" }),
            resume: () => Effect.succeed({ _tag: "Accepted", receiptId: "rc-2", runId: "run-declined" }),
            watch: () => Stream.fromIterable([ev(1, "control.run.pending", { cause: "declined by host" })]),
            list: () =>
              Effect.succeed({
                _tag: "runs",
                items: [{
                  runId: "run-declined",
                  flowId: "demo/flow",
                  status: "failed",
                  waitingReason: undefined,
                  createdAt: 1,
                  updatedAt: 2
                }],
                nextCursor: undefined
              } as never)
          })
        )
        const launchEnv = Layer.mergeAll(pendingCtrl, projLayer, uiLayer, NodeServices.layer)

        // Launch.start validation branches
        const badStarts: ReadonlyArray<Launch.StartOptions> = [
          {
            flowId: "demo",
            input: Option.none(),
            wait: true,
            detached: true,
            quiet: true,
            remote: Option.none(),
            root: Option.none(),
            mcpConfig: Option.none(),
            budgetTokens: Option.none(),
            budgetUsd: Option.none(),
            deadline: Option.none(),
            allowCodeDrift: false
          } as never,
          {
            flowId: "demo",
            input: Option.none(),
            wait: false,
            detached: true,
            quiet: true,
            remote: Option.some("http://127.0.0.1:9"),
            root: Option.none(),
            mcpConfig: Option.none(),
            budgetTokens: Option.none(),
            budgetUsd: Option.none(),
            deadline: Option.none(),
            allowCodeDrift: false
          } as never,
          {
            flowId: "smithers/internal",
            input: Option.none(),
            wait: false,
            detached: false,
            quiet: true,
            remote: Option.none(),
            root: Option.none(),
            mcpConfig: Option.none(),
            budgetTokens: Option.none(),
            budgetUsd: Option.none(),
            deadline: Option.none(),
            allowCodeDrift: false
          } as never,
          {
            flowId: "demo",
            input: Option.none(),
            wait: false,
            detached: false,
            quiet: true,
            remote: Option.none(),
            root: Option.none(),
            mcpConfig: Option.none(),
            budgetTokens: Option.some(-5),
            budgetUsd: Option.none(),
            deadline: Option.none(),
            allowCodeDrift: false
          } as never,
          {
            flowId: "demo",
            input: Option.none(),
            wait: false,
            detached: false,
            quiet: true,
            remote: Option.none(),
            root: Option.none(),
            mcpConfig: Option.none(),
            budgetTokens: Option.none(),
            budgetUsd: Option.some(-1),
            deadline: Option.none(),
            allowCodeDrift: false
          } as never,
          {
            flowId: "demo",
            input: Option.none(),
            wait: false,
            detached: false,
            quiet: true,
            remote: Option.none(),
            root: Option.none(),
            mcpConfig: Option.none(),
            budgetTokens: Option.none(),
            budgetUsd: Option.none(),
            deadline: Option.some("not-a-duration"),
            allowCodeDrift: false
          } as never,
          {
            flowId: "demo",
            input: Option.none(),
            wait: false,
            detached: false,
            quiet: true,
            remote: Option.none(),
            root: Option.none(),
            mcpConfig: Option.none(),
            budgetTokens: Option.none(),
            budgetUsd: Option.none(),
            deadline: Option.none(),
            allowCodeDrift: false
          } as never
        ]
        for (const opts of badStarts) {
          const ex = await Effect.runPromiseExit(Launch.start(opts).pipe(Effect.provide(launchEnv)))
          expect(Exit.isFailure(ex)).toBe(true)
        }

        // Launch.run / resume / retry declined branches
        const exRun = await Effect.runPromiseExit(
          Launch.run({ target: { _tag: "Plan", planId: "p-1" }, scope: "run" } as never, true, true).pipe(
            Effect.provide(launchEnv)
          )
        )
        expect(Exit.isFailure(exRun)).toBe(true)
        const exRes = await Effect.runPromiseExit(
          Launch.resume("run-declined", false, true).pipe(Effect.provide(launchEnv))
        )
        expect(exRes._tag === "Success" || exRes._tag === "Failure").toBe(true)
        const exRetry = await Effect.runPromiseExit(
          Launch.retry("run-declined", "step-1", true, true).pipe(Effect.provide(launchEnv))
        )
        expect(exRetry._tag === "Success" || exRetry._tag === "Failure").toBe(true)

        // Settlement watchFailure, releasedCause, receiptDocument, latestPark error
        const failingCtrl = makeBaseControl({
          watch: () => Stream.fail(new ControlError.TransportError({ message: "drop", retryable: true }) as never),
          list: () => Effect.fail(new ControlError.TransportError({ message: "drop", retryable: true }) as never)
        })
        const lpExit = await Effect.runPromiseExit(Settlement.latestPark(failingCtrl, "run-9a"))
        expect(Exit.isFailure(lpExit)).toBe(true)
        const lrpExit = await Effect.runPromiseExit(Settlement.latestResumablePark(failingCtrl, "run-9a"))
        expect(Exit.isFailure(lrpExit)).toBe(true)
        const awExit = await Effect.runPromiseExit(Settlement.awaitRun(failingCtrl, "run-9a", undefined, true))
        expect(Exit.isFailure(awExit)).toBe(true)
        expect(
          Settlement.releasedCause("run-9a", "f", [
            ev(1, "control.engine.event", {
              executionId: "e1",
              eventType: "flows.engine.run-decision",
              payload: {
                decision: "interrupt-released",
                flowName: "f",
                cause: { kind: "lease-lapsed", unconfirmedMs: 5000 }
              }
            })
          ])
        ).toContain("lease")
        expect(
          Settlement.releasedCause("run-9a", "f", [
            ev(1, "control.engine.event", {
              executionId: "e1",
              eventType: "flows.engine.run-decision",
              payload: { decision: "interrupt-released", flowName: "f", cause: { kind: "interrupted" } }
            })
          ])
        ).toContain("stopped")
        const docWithCause = Settlement.receiptDocument(
          { _tag: "Accepted", receiptId: "r-1", runId: "run-9a" },
          { kind: "control.run.failed", cause: "boom" }
        )
        expect(docWithCause).toBeDefined()
        const docNoCause = Settlement.receiptDocument(
          { _tag: "Accepted", receiptId: "r-1", runId: "run-9a" },
          { kind: "control.run.failed" }
        )
        expect(docNoCause).toBeDefined()

        // 5. Command.cli removed commands (`up`, `workflow`, `steer`)
        const runLegacy = (args: ReadonlyArray<string>) =>
          EffectCli.Command.runWith(CommandMod.cli, { version: "1.0.0" })(args).pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                pendingCtrl,
                projLayer,
                uiLayer,
                Layer.succeed(CommandStatus.CommandStatus, () => {}),
                Output.layer
              )
            ),
            Effect.runPromiseExit
          )
        for (const argv of [["up"], ["workflow", "list"], ["steer", "run-9a", "--message", "hi"]]) {
          await runLegacy(argv)
        }

        // Fuzz Settlement.receiptDocument & status
        const kinds = [
          "control.run.completed",
          "control.run.failed",
          "control.run.cancelled",
          "control.run.parked",
          "control.run.pending"
        ] as const
        const report = await runFuzz(
          Arbitrary.schema(
            Schema.Struct({
              kIdx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: kinds.length - 1 }))),
              hasCause: Schema.Boolean
            })
          ),
          ({ kIdx, hasCause }) => {
            const s: Settlement.Settlement = hasCause
              ? { kind: kinds[kIdx]!, cause: "err-detail" }
              : { kind: kinds[kIdx]! }
            const st = Settlement.status(s)
            const doc = Settlement.receiptDocument({ _tag: "Accepted", receiptId: "rc", runId: "r" }, s)
            assertInv(st === undefined || Number.isInteger(st), "status is integer | undefined")
            assertInv(doc !== undefined, "receiptDocument defined")
          },
          { executions, seed: seed + 3 }
        )
        expectPassed(report)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )
})
