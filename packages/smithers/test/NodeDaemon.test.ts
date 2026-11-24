import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { makeCollectorsLayer, resolveProject } from "../src/node/Collectors.ts"
import * as NodeDaemon from "../src/node/NodeDaemon.vibe"
import {
  FLEET_REPORT_MAX_BYTES,
  jsonBytes,
  MAX_SESSIONS_PER_REPORT,
  MIN_TRANSCRIPT_ENTRIES,
  planSessionsReport
} from "../src/node/SnapshotBudget.ts"

describe("NodeDaemon BYOA MCP sync", () => {
  test("syncHostOnce & syncAccountsAndCfboxOnce send MCP tools/call over HTTP with observability fields", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const rawBody = request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : "{}"
          const parsed = JSON.parse(rawBody) as {
            id: string
            params: { name: string; arguments: Record<string, unknown> }
          }
          calls.push(parsed.params)
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          )
        })
      )
    )
    const collectors = Layer.succeed(NodeDaemon.NodeCollectors, {
      collectHost: () =>
        Effect.succeed({
          nodeId: "mbp",
          name: "MacBook Pro",
          kind: "macbook",
          labels: ["macbook"],
          online: true,
          held: null,
          load1: 2.5,
          cpuCores: 16,
          memUsedGb: 32,
          memTotalGb: 64,
          diskFreeGb: 50,
          diskTotalGb: 926,
          activeSessions: 0,
          runnerCapacity: 4,
          version: "1.0.0"
        }),
      collectSessions: () =>
        Effect.succeed([
          {
            sessionKey: "mbp:agy-cli:1",
            managed: false,
            harness: "agy-cli",
            model: "gemini-4-neon-high",
            accountLabel: "google-antigravity",
            repo: "smithers",
            project: "smithersai/smithers",
            lane: null,
            title: "Audit",
            summary: "Audit fleet backend — running vitest",
            cwd: "/Users/dev/smithers",
            transcriptJson: [
              { ts: "2026-11-23T23:29:00.000Z", role: "user", label: "user", text: "Audit fleet backend" },
              { ts: "2026-11-23T23:30:00.000Z", role: "tool", label: "Bash", text: "vitest run" }
            ],
            status: "working",
            pid: null,
            cpuSeconds: null,
            tokensUsed: 12000,
            startedAt: null,
            lastActivityAt: "2026-11-23T23:30:00Z",
            endedAt: null
          }
        ]),
      collectAccounts: () =>
        Effect.succeed([
          {
            accountKey: "google-agy:google-antigravity",
            provider: "google-agy",
            label: "google-antigravity",
            plan: "google-gemini-only",
            status: "ready",
            fiveHourPct: null,
            weeklyPct: null,
            scopedPct: null,
            resetsAt: null,
            grantsJson: null,
            creditsBalance: null,
            activeSessions: 1,
            pools: ["agy-gemini"],
            coolReason: null,
            coolUntil: null,
            checkedAt: "2026-11-23T23:30:00Z"
          }
        ]),
      collectCfbox: () =>
        Effect.succeed({
          host: {
            nodeId: "cloudflare-cfbox",
            name: "Cloudflare Sandboxes (cfbox)",
            kind: "cloudflare",
            labels: ["cloudflare"],
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
              sessionKey: "cloudflare-cfbox:cfbox:job-1",
              managed: true,
              harness: "cfbox",
              model: null,
              accountLabel: null,
              repo: null,
              project: "smithersai/smithers",
              lane: "smithers-ci-1",
              title: "node26 (job-1)",
              summary: "cfbox node26 · smithers-ci-1 (running)",
              cwd: null,
              transcriptJson: null,
              status: "working",
              pid: null,
              cpuSeconds: null,
              tokensUsed: null,
              startedAt: null,
              lastActivityAt: "2026-11-23T23:30:00Z",
              endedAt: null
            }
          ]
        })
    })
    const mcp = { origin: "https://smithers.sh", token: "sma_" + "a".repeat(64) }
    await Effect.runPromise(
      NodeDaemon.runDaemon({
        mcp,
        intervalMs: 1000,
        accountIntervalMs: 1000,
        collectAccounts: true,
        collectCfbox: true,
        once: true
      }).pipe(Effect.provide(Layer.merge(httpLayer, collectors)))
    )
    expect(calls.map((c) => c.name)).toEqual([
      "fleet_heartbeat",
      "fleet_sessions_report",
      "fleet_accounts_report",
      "fleet_heartbeat",
      "fleet_sessions_report"
    ])
    const reportedSessions = calls[1]?.arguments["sessions"] as ReadonlyArray<Record<string, unknown>>
    expect(reportedSessions[0]?.["project"]).toBe("smithersai/smithers")
    expect(reportedSessions[0]?.["summary"]).toBe("Audit fleet backend — running vitest")
    expect(reportedSessions[0]?.["cwd"]).toBe("/Users/dev/smithers")
    expect(Array.isArray(reportedSessions[0]?.["transcriptJson"])).toBe(true)
  })
})

describe("Collectors observability", () => {
  test("resolveProject parses .git/config, .git worktree gitdir, .jj/repo pointer, and fallback hints", () => {
    const root = mkdtempSync(join(tmpdir(), "smthrs-proj-"))
    try {
      // 1. Standard .git/config (SSH URL)
      const gitRepo = join(root, "repo-a")
      mkdirSync(join(gitRepo, ".git"), { recursive: true })
      writeFileSync(
        join(gitRepo, ".git", "config"),
        `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:smithersai/smithers.git\n`
      )
      const nested = join(gitRepo, "apps", "mvp")
      mkdirSync(nested, { recursive: true })
      expect(resolveProject(nested, null)).toBe("smithersai/smithers")

      // 2. .git file pointing to worktree gitdir + commondir
      const mainGit = join(root, "main-git")
      const wtGit = join(mainGit, "worktrees", "wt1")
      mkdirSync(wtGit, { recursive: true })
      writeFileSync(
        join(mainGit, "config"),
        `[remote "origin"]\n\turl = https://github.com/evmts/voltaire.git\n`
      )
      writeFileSync(join(wtGit, "commondir"), "../..\n")
      const wtDir = join(root, "wt-checkout")
      mkdirSync(wtDir, { recursive: true })
      writeFileSync(join(wtDir, ".git"), `gitdir: ${wtGit}\n`)
      expect(resolveProject(wtDir, null)).toBe("evmts/voltaire")

      // 3. .jj/repo file pointing to parent repo's .jj/repo with store/git/config
      const jjParent = join(root, "vibe-parent")
      mkdirSync(join(jjParent, ".jj", "repo", "store", "git"), { recursive: true })
      writeFileSync(
        join(jjParent, ".jj", "repo", "store", "git", "config"),
        `[remote "origin"]\n\turl = ssh://git@github.com/smithersai/vibelang.git\n`
      )
      const jjWorkspace = join(root, "vibe-ws")
      mkdirSync(join(jjWorkspace, ".jj"), { recursive: true })
      writeFileSync(join(jjWorkspace, ".jj", "repo"), "../../vibe-parent/.jj/repo")
      expect(resolveProject(jjWorkspace, null)).toBe("smithersai/vibelang")

      // 4. Fallback heuristics without git/jj metadata
      expect(resolveProject("/tmp/vibelang-scratch", null)).toBe("smithersai/vibelang")
      expect(resolveProject("/tmp/scratch", "working on effectscript compiler")).toBe("smithersai/vibelang")
      expect(resolveProject("/tmp/custom-workspace", null)).toBe("custom-workspace")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("collectSessions extracts project, summary, cwd, and OBS-5 scrubbed transcripts for Claude, Codex, and AGY", async () => {
    const home = mkdtempSync(join(tmpdir(), "smthrs-home-"))
    try {
      const secret = "ghp_SecretToken1234567890abcdef"
      const ws = join(home, "smithers-ws")
      mkdirSync(join(ws, ".git"), { recursive: true })
      writeFileSync(
        join(ws, ".git", "config"),
        `[remote "origin"]\n\turl = git@github.com:smithersai/smithers.git\n`
      )

      // 1. Claude fixture (using current process.pid so pidAlive(pid) === true)
      const claudeDir = join(home, ".claude")
      mkdirSync(join(claudeDir, "sessions"), { recursive: true })
      writeFileSync(
        join(claudeDir, "sessions", `${process.pid}.json`),
        JSON.stringify({ pid: process.pid, sessionId: "claude-s1", cwd: ws, status: "working" })
      )
      const encodedWs = ws.replace(/[/.]/g, "-")
      mkdirSync(join(claudeDir, "projects", encodedWs), { recursive: true })
      writeFileSync(
        join(claudeDir, "projects", encodedWs, "claude-s1.jsonl"),
        [
          JSON.stringify({
            type: "user",
            timestamp: "2026-11-24T04:00:00Z",
            gitBranch: "feat/fleet",
            message: { role: "user", content: "<system-reminder>ignore me</system-reminder>" }
          }),
          JSON.stringify({
            type: "user",
            timestamp: "2026-11-24T04:00:01Z",
            gitBranch: "feat/fleet",
            message: { role: "user", content: `Upgrade fleet observability without leaking ${secret}` }
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-24T04:01:00Z",
            message: {
              role: "assistant",
              model: "claude-opus-4-7",
              usage: { input_tokens: 1000, output_tokens: 250, cache_read_input_tokens: 5000 },
              content: [
                { type: "tool_use", name: "Edit", input: { file_path: join(ws, "Collectors.ts") } },
                { type: "text", text: "Finished updating Collectors.ts and verifying tests." }
              ]
            }
          })
        ].join("\n") + "\n"
      )

      // 2. Codex fixture (today's date dir)
      const today = new Date()
      const yyyy = String(today.getFullYear())
      const mm = String(today.getMonth() + 1).padStart(2, "0")
      const dd = String(today.getDate()).padStart(2, "0")
      const codexDayDir = join(home, ".codex", "sessions", yyyy, mm, dd)
      mkdirSync(codexDayDir, { recursive: true })
      writeFileSync(
        join(codexDayDir, "rollout-2026-11-24T04-00-00-codex-s1.jsonl"),
        [
          JSON.stringify({
            timestamp: "2026-11-24T04:00:00Z",
            type: "session_meta",
            payload: { cwd: ws, timestamp: "2026-11-24T04:00:00Z" }
          }),
          JSON.stringify({
            timestamp: "2026-11-24T04:00:01Z",
            type: "turn_context",
            payload: { cwd: ws, model: "gpt-6-astra" }
          }),
          JSON.stringify({
            timestamp: "2026-11-24T04:00:02Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>skip</INSTRUCTIONS>" }]
            }
          }),
          JSON.stringify({
            timestamp: "2026-11-24T04:00:03Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Fix ElectricSQL fleet schema migration" }]
            }
          }),
          JSON.stringify({
            timestamp: "2026-11-24T04:01:00Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              name: "exec",
              input: `pnpm vitest run --token ${secret}`
            }
          }),
          JSON.stringify({
            timestamp: "2026-11-24T04:01:10Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Migration 0129 passes all Postgres tests." }]
            }
          }),
          JSON.stringify({
            timestamp: "2026-11-24T04:01:15Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: { total_token_usage: { total_tokens: 45678 } }
            }
          })
        ].join("\n") + "\n"
      )

      // 3. AGY CLI fixture (sqlite3 conversation_summaries.db + brain transcript.jsonl)
      const agyRoot = join(home, ".gemini", "antigravity-cli")
      const convId = "conv-obs-1"
      mkdirSync(join(agyRoot, "brain", convId, ".system_generated", "logs"), { recursive: true })
      const dbPath = join(agyRoot, "conversation_summaries.db")
      execFileSync("sqlite3", [
        dbPath,
        `CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, status TEXT, not_fully_idle INTEGER, last_modified_time TEXT);
         INSERT INTO conversation_summaries VALUES ('${convId}', 'Fleet Observability', 'CASCADE_RUN_STATUS_RUNNING', 1, datetime('now'));`
      ])
      writeFileSync(
        join(agyRoot, "brain", convId, ".system_generated", "logs", "transcript.jsonl"),
        [
          JSON.stringify({
            type: "USER_INPUT",
            created_at: "2026-11-24T04:00:00Z",
            content: `<USER_REQUEST>\nAudit ${ws} fleet pipeline with ${secret}\n</USER_REQUEST>`
          }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-24T04:00:30Z",
            model: "gemini-4-neon-high",
            input_tokens: 2000,
            cache_read_tokens: 8000,
            output_tokens: 500,
            tool_calls: [{ name: "read_file", args: { Path: `"${join(ws, "FleetStore.vibe")}"` } }],
            content: "Verified FleetStore and Collectors end to end."
          })
        ].join("\n") + "\n"
      )

      const layer = makeCollectorsLayer({
        nodeId: "test-node",
        name: "Test Node",
        kind: "mac-mini",
        labels: ["test"],
        version: "1.0.0",
        home
      })
      const sessions = await Effect.runPromise(
        Effect.flatMap(NodeDaemon.NodeCollectors, (c) => c.collectSessions()).pipe(Effect.provide(layer))
      )

      const serialized = JSON.stringify(sessions)
      expect(serialized).not.toContain(secret)

      const claude = sessions.find((s) => s.sessionKey === "test-node:claude:claude-s1")
      expect(claude).toBeDefined()
      expect(claude?.project).toBe("smithersai/smithers")
      expect(claude?.cwd).toBe(ws)
      expect(claude?.tokensUsed).toBe(6250)
      expect(claude?.summary).toContain("Upgrade fleet observability")
      expect(claude?.summary).toContain("Finished updating Collectors.ts")
      expect(claude?.transcriptJson?.some((e) => e.role === "tool" && e.label === "Edit" && e.text === "Collectors.ts"))
        .toBe(true)

      const codex = sessions.find((s) => s.harness === "codex" && s.sessionKey.includes("codex-s1"))
      expect(codex).toBeDefined()
      expect(codex?.model).toBe("gpt-6-astra")
      expect(codex?.project).toBe("smithersai/smithers")
      expect(codex?.cwd).toBe(ws)
      expect(codex?.tokensUsed).toBe(45678)
      expect(codex?.summary).toContain("Fix ElectricSQL fleet schema migration")
      expect(codex?.summary).toContain("Migration 0129 passes")
      expect(
        codex?.transcriptJson?.some((e) => e.role === "tool" && e.label === "exec" && e.text.includes("[redacted]"))
      ).toBe(true)

      const agy = sessions.find((s) => s.sessionKey === `test-node:agy-cli:${convId}`)
      expect(agy).toBeDefined()
      expect(agy?.model).toBe("gemini-4-neon-high")
      expect(agy?.tokensUsed).toBe(10500)
      expect(agy?.project).toBe("smithersai/smithers")
      expect(agy?.summary).toContain("Verified FleetStore")
      expect(
        agy?.transcriptJson?.some((e) => e.role === "tool" && e.label === "read_file" && e.text === "FleetStore.vibe")
      ).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("NodeDaemon fleet snapshot byte budget & chunking (R2-Astra-D4-011)", () => {
  const MCP_MAX_REQUEST_BYTES = 262_144

  const makeHost = (nodeId: string): NodeDaemon.HostSnapshot => ({
    nodeId,
    name: nodeId,
    kind: "bare-metal",
    labels: ["linux"],
    online: true,
    held: null,
    load1: 1.5,
    cpuCores: 32,
    memUsedGb: 16,
    memTotalGb: 128,
    diskFreeGb: 400,
    diskTotalGb: 1000,
    activeSessions: 0,
    runnerCapacity: 16,
    version: "1.0.0"
  })

  const makeTranscript = (sessionIdx: number, count: number): ReadonlyArray<NodeDaemon.TranscriptEntry> =>
    Array.from({ length: count }, (_, i) => ({
      ts: `2026-11-24T04:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      role: i % 2 === 0 ? "user" : "assistant",
      label: `turn-${i}`,
      text: `s${sessionIdx}-e${i}-${"x".repeat(345)}`
    }))

  const makeSession = (
    nodeId: string,
    idx: number,
    transcriptCount: number | null
  ): NodeDaemon.SessionSnapshot => ({
    sessionKey: `${nodeId}:claude:session-${idx}`,
    managed: false,
    harness: "claude",
    model: "claude-fable-5-2",
    accountLabel: "claude-1",
    repo: "smithers",
    project: "smithersai/smithers",
    lane: `lane-${idx}`,
    title: `Session ${idx}`,
    summary: `Running fleet sync verification for session ${idx}`,
    cwd: `/home/lane/ws-${idx}`,
    transcriptJson: transcriptCount === null ? null : makeTranscript(idx, transcriptCount),
    status: "working",
    pid: 1000 + idx,
    cpuSeconds: 12.5,
    tokensUsed: 10_000 + idx,
    startedAt: "2026-11-24T04:00:00.000Z",
    lastActivityAt: "2026-11-24T04:10:00.000Z",
    endedAt: null
  })

  const makeCapturingHttpLayer = () => {
    const requests: Array<{
      readonly bodyBytes: number
      readonly name: string
      readonly arguments: Record<string, unknown>
    }> = []
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const rawBytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array()
          const rawText = new TextDecoder().decode(rawBytes)
          const parsed = JSON.parse(rawText) as {
            id: string
            params: { name: string; arguments: Record<string, unknown> }
          }
          requests.push({
            bodyBytes: rawBytes.byteLength,
            name: parsed.params.name,
            arguments: parsed.params.arguments
          })
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          )
        })
      )
    )
    return { requests, httpLayer }
  }

  test("40-session x 20-entry snapshot trims oldest transcript entries to fit under MCP limit in one request", async () => {
    const sessions = Array.from({ length: 40 }, (_, i) => makeSession("nyc-02", i, 20))
    // Confirm the raw untrimmed snapshot would breach MCP's 262,144-byte cap.
    expect(jsonBytes({ nodeId: "nyc-02", replaceActive: true, sessions })).toBeGreaterThan(MCP_MAX_REQUEST_BYTES)

    const { requests, httpLayer } = makeCapturingHttpLayer()
    const collectors = Layer.succeed(NodeDaemon.NodeCollectors, {
      collectHost: () => Effect.succeed(makeHost("nyc-02")),
      collectSessions: () => Effect.succeed(sessions),
      collectAccounts: () => Effect.succeed([]),
      collectCfbox: () => Effect.succeed(null)
    })
    const mcp = { origin: "https://smithers.sh", token: "sma_" + "b".repeat(64) }
    const result = await Effect.runPromise(
      NodeDaemon.syncHostOnce(mcp).pipe(Effect.provide(Layer.merge(httpLayer, collectors)))
    )
    expect(result).toEqual({ nodeId: "nyc-02", sessions: 40 })

    const reports = requests.filter((r) => r.name === "fleet_sessions_report")
    expect(reports).toHaveLength(1)
    expect(reports[0]!.bodyBytes).toBeLessThanOrEqual(MCP_MAX_REQUEST_BYTES)
    expect(jsonBytes(reports[0]!.arguments)).toBeLessThanOrEqual(FLEET_REPORT_MAX_BYTES)
    expect(reports[0]!.arguments["replaceActive"]).toBe(true)
    expect(reports[0]!.arguments["snapshotId"]).toBeUndefined()

    const sent = reports[0]!.arguments["sessions"] as ReadonlyArray<NodeDaemon.SessionSnapshot>
    expect(sent.map((s) => s.sessionKey)).toEqual(sessions.map((s) => s.sessionKey))
    for (const s of sent) {
      expect(s.transcriptJson).not.toBeNull()
      expect(s.transcriptJson!.length).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_ENTRIES)
      expect(s.transcriptJson!.length).toBeLessThan(20)
      // Oldest entries are dropped first; newest entry ("turn-19") is preserved.
      expect(s.transcriptJson![s.transcriptJson!.length - 1]?.label).toBe("turn-19")
    }
  })

  test("busy host exceeding byte budget even after transcript trimming chunks under one snapshotId", async () => {
    const sessions = Array.from({ length: 160 }, (_, i) => makeSession("nyc-01", i, 20))
    const { requests, httpLayer } = makeCapturingHttpLayer()
    const collectors = Layer.succeed(NodeDaemon.NodeCollectors, {
      collectHost: () => Effect.succeed(makeHost("nyc-01")),
      collectSessions: () => Effect.succeed(sessions),
      collectAccounts: () => Effect.succeed([]),
      collectCfbox: () => Effect.succeed(null)
    })
    const mcp = { origin: "https://smithers.sh", token: "sma_" + "c".repeat(64) }
    await Effect.runPromise(
      NodeDaemon.syncHostOnce(mcp).pipe(Effect.provide(Layer.merge(httpLayer, collectors)))
    )

    const reports = requests.filter((r) => r.name === "fleet_sessions_report")
    expect(reports.length).toBeGreaterThan(1)

    const snapshotId = reports[0]!.arguments["snapshotId"]
    expect(typeof snapshotId).toBe("string")
    expect((snapshotId as string).length).toBeGreaterThan(0)
    expect((snapshotId as string).length).toBeLessThanOrEqual(128)

    const deliveredKeys: Array<string> = []
    for (let i = 0; i < reports.length; i += 1) {
      const report = reports[i]!
      expect(report.bodyBytes).toBeLessThanOrEqual(MCP_MAX_REQUEST_BYTES)
      expect(jsonBytes(report.arguments)).toBeLessThanOrEqual(FLEET_REPORT_MAX_BYTES)
      expect(report.arguments["nodeId"]).toBe("nyc-01")
      expect(report.arguments["replaceActive"]).toBe(true)
      expect(report.arguments["snapshotId"]).toBe(snapshotId)
      expect(report.arguments["chunkIndex"]).toBe(i)
      expect(report.arguments["totalChunks"]).toBe(reports.length)
      expect(report.arguments["final"]).toBe(i === reports.length - 1)
      const chunkSessions = report.arguments["sessions"] as ReadonlyArray<NodeDaemon.SessionSnapshot>
      expect(chunkSessions.length).toBeGreaterThan(0)
      expect(chunkSessions.length).toBeLessThanOrEqual(MAX_SESSIONS_PER_REPORT)
      for (const s of chunkSessions) deliveredKeys.push(s.sessionKey)
    }
    expect(deliveredKeys).toEqual(sessions.map((s) => s.sessionKey))
  })

  test("more than MAX_SESSIONS_PER_REPORT compact sessions chunk under one snapshotId", async () => {
    const total = MAX_SESSIONS_PER_REPORT + 20
    const sessions = Array.from({ length: total }, (_, i) => makeSession("cf-pool", i, null))
    const { requests, httpLayer } = makeCapturingHttpLayer()
    const collectors = Layer.succeed(NodeDaemon.NodeCollectors, {
      collectHost: () => Effect.succeed(makeHost("mbp")),
      collectSessions: () => Effect.succeed([]),
      collectAccounts: () => Effect.succeed([]),
      collectCfbox: () => Effect.succeed({ host: makeHost("cf-pool"), sessions })
    })
    const mcp = { origin: "https://smithers.sh", token: "sma_" + "d".repeat(64) }
    const result = await Effect.runPromise(
      NodeDaemon.syncAccountsAndCfboxOnce(mcp, false, true).pipe(Effect.provide(Layer.merge(httpLayer, collectors)))
    )
    expect(result).toEqual({ accounts: 0, cfboxSessions: total })

    const reports = requests.filter((r) => r.name === "fleet_sessions_report")
    expect(reports.length).toBeGreaterThanOrEqual(2)
    const snapshotId = reports[0]!.arguments["snapshotId"]
    expect(typeof snapshotId).toBe("string")
    const deliveredKeys: Array<string> = []
    for (let i = 0; i < reports.length; i += 1) {
      const r = reports[i]!
      expect(r.bodyBytes).toBeLessThanOrEqual(MCP_MAX_REQUEST_BYTES)
      expect(jsonBytes(r.arguments)).toBeLessThanOrEqual(FLEET_REPORT_MAX_BYTES)
      expect(r.arguments["snapshotId"]).toBe(snapshotId)
      expect(r.arguments["chunkIndex"]).toBe(i)
      expect(r.arguments["totalChunks"]).toBe(reports.length)
      expect(r.arguments["final"]).toBe(i === reports.length - 1)
      const chunkSessions = r.arguments["sessions"] as ReadonlyArray<NodeDaemon.SessionSnapshot>
      expect(chunkSessions.length).toBeGreaterThan(0)
      expect(chunkSessions.length).toBeLessThanOrEqual(MAX_SESSIONS_PER_REPORT)
      for (const s of chunkSessions) deliveredKeys.push(s.sessionKey)
    }
    expect(deliveredKeys).toEqual(sessions.map((s) => s.sessionKey))
  })

  test("planSessionsReport handles empty snapshots and drops transcript on a single oversized session", () => {
    const empty = planSessionsReport({ nodeId: "empty-node", sessions: [], snapshotId: "snap-empty" })
    expect(empty).toEqual([{ nodeId: "empty-node", replaceActive: true, sessions: [] }])

    const oversized = makeSession("big-node", 0, 20)
    const planned = planSessionsReport({
      nodeId: "big-node",
      sessions: [oversized],
      snapshotId: "snap-single",
      maxBytes: 1_200
    })
    expect(planned).toHaveLength(1)
    expect(planned[0]!.snapshotId).toBe("snap-single")
    expect(planned[0]!.chunkIndex).toBe(0)
    expect(planned[0]!.totalChunks).toBe(1)
    expect(planned[0]!.final).toBe(true)
    expect(planned[0]!.sessions).toHaveLength(1)
    expect(planned[0]!.sessions[0]!.sessionKey).toBe(oversized.sessionKey)
    expect(planned[0]!.sessions[0]!.transcriptJson).toBeNull()
    expect(jsonBytes(planned[0])).toBeLessThanOrEqual(1_200)

    // Count-based chunking when small sessions fit in bytes but exceed MAX_SESSIONS_PER_REPORT.
    const tiny = Array.from({ length: MAX_SESSIONS_PER_REPORT + 20 }, (_, i) => ({ sessionKey: `tiny:${i}` }))
    const countPlanned = planSessionsReport({ nodeId: "tiny-node", sessions: tiny, snapshotId: "snap-count" })
    expect(countPlanned).toHaveLength(2)
    expect(countPlanned[0]!.sessions).toHaveLength(MAX_SESSIONS_PER_REPORT)
    expect(countPlanned[0]!.final).toBe(false)
    expect(countPlanned[1]!.sessions).toHaveLength(20)
    expect(countPlanned[1]!.final).toBe(true)
    expect(countPlanned[0]!.snapshotId).toBe("snap-count")
    expect(countPlanned[1]!.snapshotId).toBe("snap-count")
  })
})
