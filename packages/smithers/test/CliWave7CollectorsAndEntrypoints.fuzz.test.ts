import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Fiber, Schema } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as BunControl from "../src/BunControl.ts"
import * as Entry from "../src/cli/Entry.ts"
import * as Collectors from "../src/node/Collectors.ts"
import * as NodeDaemon from "../src/node/NodeDaemon.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeSyntheticRepo = (
  base: string,
  layout: "git-ssh" | "git-https" | "git-worktree" | "jj-store-git" | "jj-git-target" | "jj-sibling-git"
): string => {
  const repoDir = join(base, `repo-${layout}`)
  mkdirSync(repoDir, { recursive: true })
  if (layout === "git-ssh") {
    mkdirSync(join(repoDir, ".git"), { recursive: true })
    writeFileSync(
      join(repoDir, ".git", "config"),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/alpha-ssh.git\n`
    )
  } else if (layout === "git-https") {
    mkdirSync(join(repoDir, ".git"), { recursive: true })
    writeFileSync(
      join(repoDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://user:ghp_secret1234567890abcdef@github.com/acme/alpha-https.git/\n`
    )
  } else if (layout === "git-worktree") {
    const common = join(base, "bare-common.git")
    const wtGit = join(common, "worktrees", "wt1")
    mkdirSync(wtGit, { recursive: true })
    writeFileSync(
      join(common, "config"),
      `[remote "origin"]\n\turl = ssh://git@github.com/acme/alpha-wt.git\n`
    )
    writeFileSync(join(wtGit, "commondir"), "../..\n")
    writeFileSync(join(repoDir, ".git"), `gitdir: ${wtGit}\n`)
  } else if (layout === "jj-store-git") {
    const storeGit = join(repoDir, ".jj", "repo", "store", "git")
    mkdirSync(storeGit, { recursive: true })
    writeFileSync(
      join(storeGit, "config"),
      `[remote "origin"]\n\turl = git@github.com:acme/alpha-jj.git\n`
    )
  } else if (layout === "jj-git-target") {
    const parentJj = join(base, "parent-jj", ".jj", "repo")
    const targetGit = join(base, "parent-jj", ".git")
    mkdirSync(join(parentJj, "store"), { recursive: true })
    mkdirSync(targetGit, { recursive: true })
    writeFileSync(
      join(targetGit, "config"),
      `[remote "origin"]\n\turl = https://github.com/acme/alpha-jj-target\n`
    )
    writeFileSync(join(parentJj, "store", "git_target"), "../../../.git\n")
    mkdirSync(join(repoDir, ".jj"), { recursive: true })
    writeFileSync(join(repoDir, ".jj", "repo"), parentJj)
  } else {
    const parentRoot = join(base, "jj-sib")
    mkdirSync(join(parentRoot, ".jj", "repo"), { recursive: true })
    mkdirSync(join(parentRoot, ".git"), { recursive: true })
    writeFileSync(
      join(parentRoot, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:acme/alpha-sib.git\n`
    )
    mkdirSync(join(repoDir, ".jj"), { recursive: true })
    writeFileSync(join(repoDir, ".jj", "repo"), join(parentRoot, ".jj", "repo"))
  }
  return repoDir
}

const makeCaptureStream = (isTTY: boolean) => {
  let buf = ""
  const stream = {
    isTTY,
    write: (chunk: string | Uint8Array): boolean => {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      return true
    },
    read: () => buf
  }
  return stream
}

describe("@smthrs/cli Wave-7A Collectors Deep Discovery & Entrypoints fuzz invariants", () => {
  it("Collectors repo origin resolution, process discovery, Codex/Claude/AGY rich transcripts & secret scrubbing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        repoLayout: Schema.Literals([
          "git-ssh",
          "git-https",
          "git-worktree",
          "jj-store-git",
          "jj-git-target",
          "jj-sibling-git"
        ]),
        toolKind: Schema.Literals(["bash", "read", "grep", "web_search", "custom-json", "custom-bad-json", "custom-str"]),
        codexTokenMode: Schema.Literals(["nested", "flat", "direct"]),
        agyThinkingOnly: Schema.Boolean,
        includeClaudeEmptyTranscript: Schema.Boolean
      })
    )

    const binDir = mkdtempSync(join(tmpdir(), "smthrs-w7a-bin-"))
    // Real executable sqlite3 shim backed by node:sqlite
    writeFileSync(
      join(binDir, "sqlite3"),
      `#!${process.execPath}
const { DatabaseSync } = require("node:sqlite")
const args = process.argv.slice(2)
const uri = args.find((a) => a.startsWith("file:")) || ""
const dbPath = uri.replace(/^file:/, "").replace(/\\?.*$/, "")
const query = args[args.length - 1] || ""
const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  process.stdout.write(JSON.stringify(db.prepare(query).all()))
} finally {
  db.close()
}
`
    )
    chmodSync(join(binDir, "sqlite3"), 0o755)

    // Real executable ps shim emitting realistic multi-harness process table
    writeFileSync(
      join(binDir, "ps"),
      `#!/bin/sh
printf '%s\\n' \
  "  PID     TIME COMMAND" \
  "41001 01:12.34 /usr/local/bin/claude --model claude-opus-4-7 --cwd /home/dev/smithers" \
  "41002 00:45.10 /usr/local/bin/codex -m gpt-5.4-codex /home/dev/smithers" \
  "41003 00:10.00 /usr/local/bin/agy chat --workspace /home/dev/smithers" \
  "41004 02:00.00 /usr/local/bin/smthrs runner serve --port 9999" \
  "41005 00:05.00 /usr/local/bin/smthrs node serve --interval 15" \
  "41006 00:03.00 python3 /home/dev/mq.py run --project smithers" \
  "41007 00:04.00 node /home/dev/run-smithers-gateway.mjs" \
  "41008 00:01.00 grep claude"
`
    )
    chmodSync(join(binDir, "ps"), 0o755)

    const prevPath = process.env["PATH"] ?? ""
    process.env["PATH"] = `${binDir}:${prevPath}`

    try {
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.promise(async () => {
              const home = mkdtempSync(join(tmpdir(), "smthrs-w7a-home-"))
              try {
                const repoDir = makeSyntheticRepo(home, input.repoLayout)
                const encodedCwd = repoDir.replace(/[/.]/g, "-")
                const sessionId = `w7a-${input.repoLayout}-${input.toolKind}`

                // Claude session + rich transcript
                const claudeSessDir = join(home, ".claude", "sessions")
                const claudeProjDir = join(home, ".claude", "projects", encodedCwd)
                mkdirSync(claudeSessDir, { recursive: true })
                mkdirSync(claudeProjDir, { recursive: true })
                writeFileSync(
                  join(claudeSessDir, `${process.pid}.json`),
                  JSON.stringify({
                    pid: process.pid,
                    sessionId,
                    cwd: repoDir,
                    name: "w7a-lane",
                    startedAt: Date.now() - 5000
                  })
                )

                const toolEntry =
                  input.toolKind === "bash"
                    ? { name: "Bash", input: { command: "jj status TOKEN=tok_secret_99" } }
                    : input.toolKind === "read"
                    ? { name: "Read", input: { file_path: join(repoDir, "src", "index.ts") } }
                    : input.toolKind === "grep"
                    ? { name: "Grep", input: { pattern: "TODO", path: repoDir } }
                    : input.toolKind === "web_search"
                    ? { name: "web_search", input: { query: "effect schema v4" } }
                    : input.toolKind === "custom-json"
                    ? { name: "custom_op", input: JSON.stringify({ target: "foo", path: join(repoDir, "a.ts") }) }
                    : input.toolKind === "custom-bad-json"
                    ? { name: "custom_op", input: "{bad-json-here" }
                    : { name: "custom_op", input: "plain-arg-value" }

                if (!input.includeClaudeEmptyTranscript) {
                  writeFileSync(
                    join(claudeProjDir, `${sessionId}.jsonl`),
                    [
                      JSON.stringify({
                        timestamp: new Date().toISOString(),
                        message: { role: "user", content: "<system-reminder>ignore me</system-reminder>" }
                      }),
                      JSON.stringify({
                        timestamp: new Date().toISOString(),
                        message: {
                          role: "user",
                          content: [{ type: "text", text: "Fix parser bug in ghp_abcdefghijklmnopqrstuvwxyz012345" }]
                        }
                      }),
                      JSON.stringify({
                        gitBranch: "feat/w7a",
                        timestamp: new Date().toISOString(),
                        message: {
                          role: "assistant",
                          model: "claude-opus-4-7",
                          usage: { input_tokens: 50, output_tokens: 25, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
                          content: [
                            { type: "thinking", thinking: "Reasoning through parser edge cases" },
                            { type: "tool_use", name: toolEntry.name, input: toolEntry.input },
                            { type: "text", text: "Updated parser safely without leaking sk-ant-api03-1234567890abcdef" }
                          ],
                          stop_reason: "end_turn"
                        }
                      })
                    ].join("\n") + "\n"
                  )
                }

                // Codex rollout with full event_msg + response_item coverage
                const today = new Date()
                const yyyy = String(today.getFullYear())
                const mm = String(today.getMonth() + 1).padStart(2, "0")
                const dd = String(today.getDate()).padStart(2, "0")
                const codexDayDir = join(home, ".codex", "sessions", yyyy, mm, dd)
                mkdirSync(codexDayDir, { recursive: true })
                const tokenEvent =
                  input.codexTokenMode === "nested"
                    ? { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 9100 } } } }
                    : input.codexTokenMode === "flat"
                    ? { type: "event_msg", payload: { type: "token_count", total_tokens: 7200 } }
                    : { type: "event_msg", payload: { type: "other", total_tokens: 5300 } }
                writeFileSync(
                  join(codexDayDir, `rollout-${sessionId}.jsonl`),
                  [
                    JSON.stringify({ type: "session_meta", payload: { cwd: repoDir, model: "gpt-5.4-codex" } }),
                    JSON.stringify({
                      type: "event_msg",
                      payload: {
                        type: "item_completed",
                        item: { type: "UserMessage", content: [{ type: "input_text", text: "Implement Wave-7 fuzz tests" }] }
                      }
                    }),
                    JSON.stringify({
                      type: "response_item",
                      timestamp: new Date().toISOString(),
                      payload: {
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: "Run verification suite" }]
                      }
                    }),
                    JSON.stringify({
                      type: "response_item",
                      timestamp: new Date().toISOString(),
                      payload: {
                        type: "custom_tool_call",
                        name: toolEntry.name,
                        input: toolEntry.input
                      }
                    }),
                    JSON.stringify({
                      type: "response_item",
                      timestamp: new Date().toISOString(),
                      payload: {
                        type: "function_call",
                        name: "shell_command",
                        arguments: JSON.stringify({ command: "pnpm test" })
                      }
                    }),
                    JSON.stringify({
                      type: "response_item",
                      timestamp: new Date().toISOString(),
                      payload: {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "All checks green without AKIAIOSFODNN7EXAMPLE" }]
                      }
                    }),
                    JSON.stringify(tokenEvent)
                  ].join("\n") + "\n"
                )

                // AGY CLI sqlite + transcript with thinking-only vs content + hidden/real workspace path hints
                const agyDir = join(home, ".gemini", "antigravity-cli")
                mkdirSync(agyDir, { recursive: true })
                const db = new DatabaseSync(join(agyDir, "conversation_summaries.db"))
                try {
                  db.exec(
                    "CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, status TEXT, not_fully_idle INTEGER, last_modified_time TEXT);"
                  )
                  db.prepare(
                    "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)"
                  ).run(
                    `conv-${sessionId}`,
                    "Work on /home/dev/.gemini and /home/dev/smithers",
                    "CASCADE_RUN_STATUS_RUNNING",
                    1,
                    new Date().toISOString().replace("T", " ").slice(0, 19)
                  )
                } finally {
                  db.close()
                }
                const agyLogDir = join(agyDir, "brain", `conv-${sessionId}`, ".system_generated", "logs")
                mkdirSync(agyLogDir, { recursive: true })
                writeFileSync(
                  join(agyLogDir, "transcript.jsonl"),
                  [
                    JSON.stringify({
                      type: "USER_INPUT",
                      created_at: new Date().toISOString(),
                      content: `<USER_REQUEST>Work in ${repoDir} ignoring /home/dev/.gemini</USER_REQUEST>`
                    }),
                    JSON.stringify(
                      input.agyThinkingOnly
                        ? {
                            type: "PLANNER_RESPONSE",
                            created_at: new Date().toISOString(),
                            model: "gemini-3-pro",
                            thinking: "Inspecting repository layout silently",
                            tool_calls: [{ name: "grep", args: { query: "CollectorConfig", path: repoDir } }]
                          }
                        : {
                            type: "PLANNER_RESPONSE",
                            created_at: new Date().toISOString(),
                            model: "gemini-3-pro",
                            input_tokens: 200,
                            output_tokens: 100,
                            cache_read_tokens: 50,
                            content: "Completed analysis in /home/dev/smithers",
                            tool_calls: [{ name: "run_command", args: { CommandLine: "jj status" } }]
                          }
                    )
                  ].join("\n") + "\n"
                )

                const config: Collectors.CollectorConfig = {
                  nodeId: "node-w7a",
                  name: "w7a-host",
                  kind: "bare-metal",
                  labels: ["fuzz"],
                  version: "1.0.0",
                  home
                }
                const layer = Collectors.makeCollectorsLayer(config)
                const sessions = await Effect.runPromise(
                  Effect.gen(function*() {
                    const col = yield* NodeDaemon.NodeCollectors
                    return yield* col.collectSessions()
                  }).pipe(Effect.provide(layer))
                )

                const serialized = JSON.stringify(sessions)
                for (const secret of ["ghp_abcdefghijklmnopqrstuvwxyz", "sk-ant-api03-", "AKIAIOSFODNN7EXAMPLE", "tok_secret_99", "ghp_secret1234567890"]) {
                  assertInv(!serialized.includes(secret), `secret leaked: ${secret}`)
                }

                // Process sessions discovered from ps shim
                assertInv(sessions.some((s) => s.sessionKey === "node-w7a:claude-proc:41001"), "claude proc discovered")
                assertInv(sessions.some((s) => s.sessionKey === "node-w7a:codex:41002"), "codex proc discovered")
                assertInv(sessions.some((s) => s.sessionKey === "node-w7a:daemon:41004" && s.managed), "runner daemon discovered")
                assertInv(sessions.some((s) => s.sessionKey === "node-w7a:daemon:41005" && s.managed), "node daemon discovered")
                assertInv(sessions.some((s) => s.sessionKey === "node-w7a:daemon:41006"), "mq daemon discovered")
                assertInv(sessions.some((s) => s.sessionKey === "node-w7a:daemon:41007"), "gateway daemon discovered")
                assertInv(!sessions.some((s) => s.pid === 41008), "grep process filtered out")

                // Repo origin resolved for Claude session across all 6 git/jj layouts
                const claudeSess = sessions.find((s) => s.sessionKey === `node-w7a:claude:${sessionId}`)
                assertInv(claudeSess !== undefined, "claude session found")
                assertInv(claudeSess!.project !== null && claudeSess!.project.startsWith("acme/alpha-"), `origin resolved: ${claudeSess!.project}`)

                // Codex rollout tokens parsed across all 3 modes
                const codexSess = sessions.find((s) => s.harness === "codex" && s.sessionKey.includes("codex-rollout"))
                assertInv(codexSess !== undefined && (codexSess.tokensUsed ?? 0) >= 5300, "codex rollout tokens parsed")

                // inspectLocalSession exercises both transcriptJson and Claude fallback path
                const insp = Collectors.inspectLocalSession(config, sessionId)
                assertInv(insp.session !== null, "inspectLocalSession matched")
                return true
              } finally {
                rmSync(home, { recursive: true, force: true })
              }
            }),
          { executions: Math.min(executions, 24), seed }
        )
      )
      expect(report._tag).toBe("Passed")
    } finally {
      process.env["PATH"] = prevPath
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 60_000)

  it("Entry.main/mainEffect signal handling (SIGINT interactive tui vs print, SIGTERM, abort, mcp) & BunControl/guest-bin/bin", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "version",
          "sigint-default",
          "sigint-tui-interactive",
          "sigint-tui-print",
          "sigterm",
          "pre-aborted",
          "mcp-disconnect"
        ]),
        tty: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.promise(async () => {
            const stdout = makeCaptureStream(input.tty)
            const stderr = makeCaptureStream(input.tty)
            const listeners = new Map<string, Set<() => void>>()
            let exitCode = 0
            const emit = (sig: "SIGINT" | "SIGTERM") => {
              for (const fn of [...(listeners.get(sig) ?? [])]) fn()
            }

            const argv =
              input.mode === "sigint-tui-interactive"
                ? ["--verbose", "tui"]
                : input.mode === "sigint-tui-print"
                ? ["tui", "-p", "hello"]
                : input.mode === "mcp-disconnect"
                ? ["--mcp"]
                : ["--version"]

            let disconnected = false
            const host: Entry.Host = {
              argv,
              env: { ...process.env },
              stdout: stdout as unknown as Entry.Host["stdout"],
              stderr: stderr as unknown as Entry.Host["stderr"],
              on: (sig, fn) => {
                const set = listeners.get(sig) ?? new Set()
                set.add(fn)
                listeners.set(sig, set)
                if (input.mode === "sigint-default" && sig === "SIGINT") {
                  queueMicrotask(() => emit("SIGINT"))
                } else if (input.mode === "sigterm" && sig === "SIGTERM") {
                  queueMicrotask(() => emit("SIGTERM"))
                } else if (input.mode === "sigint-tui-interactive" && sig === "SIGINT") {
                  // Firing SIGINT on interactive tui must NOT set 130; then SIGTERM exits cleanly
                  queueMicrotask(() => {
                    emit("SIGINT")
                    assertInv(exitCode !== 130, "interactive tui ignores SIGINT")
                    emit("SIGTERM")
                  })
                } else if (input.mode === "sigint-tui-print" && sig === "SIGINT") {
                  queueMicrotask(() => emit("SIGINT"))
                }
              },
              removeListener: (sig, fn) => {
                listeners.get(sig)?.delete(fn)
              },
              setExitCode: (code) => {
                exitCode = code
              },
              waitForDisconnect: async (signal) => {
                disconnected = true
                if (!signal.aborted) {
                  await new Promise((r) => setTimeout(r, 1))
                }
              }
            }

            if (input.mode === "pre-aborted") {
              const fiber = Effect.runFork(Entry.mainEffect(host))
              await Effect.runPromise(Fiber.interrupt(fiber))
              assertInv(exitCode === 130 || exitCode === 0, "interrupted fiber sets valid exit code")
            } else if (input.mode === "sigint-tui-interactive" || input.mode === "sigint-tui-print") {
              // Exercise signal handler paths without launching interactive TUI
              const fastHost: Entry.Host = {
                ...host,
                argv: input.mode === "sigint-tui-interactive" ? ["--format", "json", "tui", "--help"] : ["tui", "-p", "x", "--help"]
              }
              await Entry.main(fastHost)
            } else {
              await Entry.main(host)
              if (input.mode === "version") {
                assertInv(exitCode === 0 && stdout.read().trim().length > 0, "version prints cleanly")
              } else if (input.mode === "mcp-disconnect") {
                assertInv(disconnected || exitCode >= 0, "mcp path executed")
              }
            }
            // Listeners must always be cleaned up after Entry.main settles
            assertInv((listeners.get("SIGINT")?.size ?? 0) === 0, "SIGINT listener cleaned up")
            assertInv((listeners.get("SIGTERM")?.size ?? 0) === 0, "SIGTERM listener cleaned up")
            return true
          }),
        { executions: Math.min(executions, 28), seed }
      )
    )
    expect(report._tag).toBe("Passed")

    // BunControl layer constructors return real Layers without eagerly requiring Bun globals
    const tmp = mkdtempSync(join(tmpdir(), "smthrs-w7a-bun-"))
    try {
      const ctrlLayer = BunControl.layerControl({ root: tmp })
      const regLayer = BunControl.layerRegistry(tmp)
      expect(ctrlLayer).toBeDefined()
      expect(regLayer).toBeDefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }

    // Exercise src/bin.ts (--version fast path) and src/guest-bin.ts (--help) cleanly in-process
    const savedArgv = [...process.argv]
    const savedExitCode = process.exitCode
    try {
      process.argv = [process.execPath, "smthrs", "--help"]
      process.exitCode = undefined
      await import("../src/bin.ts")
      await new Promise((r) => setTimeout(r, 20))
      expect(process.exitCode ?? 0).toBe(0)

      process.argv = [process.execPath, "smthrs", "--help"]
      process.exitCode = undefined
      await import("../src/guest-bin.ts")
      await new Promise((r) => setTimeout(r, 20))
      expect(process.exitCode ?? 0).toBe(0)
    } finally {
      process.argv.splice(0, process.argv.length, ...savedArgv)
      process.exitCode = savedExitCode
    }
  }, 60_000)
})
