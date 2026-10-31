// What running a vendor's own agent in a box takes (worker/personal/Agents.ts): its command run by a real shell, with
// `claude` and `codex` as stand-ins on the PATH that print what they were given, its environment, the `auth.json` the box's
// Codex reads, and what it reported. No test double of this module: the shell and base64 are the real ones the box has.
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import * as Agents from "./Agents.ts"
import * as Codex from "./Codex.ts"

const home = mkdtempSync(join(tmpdir(), "smthrs-agents-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const bin = (name: string) => {
  const path = join(home, name)
  // The stand-in prints its arguments, one line each, then what it read on stdin.
  writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done\necho ---\ncat\n`)
  chmodSync(path, 0o755)
}
bin("claude")
bin("codex")

const run = (command: string, env: Record<string, string> = {}) =>
  execFileSync("sh", ["-c", command], { env: { PATH: `${home}:${process.env["PATH"]}`, HOME: home, ...env }, encoding: "utf8" })

const ACCOUNT = { accountId: "acct-1234", planType: "plus" }
const NOW = new Date("2026-10-31T12:00:00.000Z")
const PROMPT = "Fix `this` in 'quotes' and $HOME; ünï\ncödé\n"

describe("commandOf", () => {
  test("Claude Code reads the prompt on stdin, so no process list shows it, unsupervised in JSON", () => {
    const command = Agents.commandOf("claude-code", PROMPT, undefined)
    expect(command).not.toContain("quotes")
    expect(run(command)).toBe(`-p\n--output-format\njson\n--dangerously-skip-permissions\n---\n${PROMPT}`)
  })

  test("a model it names is one shell word, however it is spelled", () => {
    expect(run(Agents.commandOf("claude-code", "p", "opus'; rm -rf /"))).toBe(
      "-p\n--output-format\njson\n--dangerously-skip-permissions\n--model\nopus'; rm -rf /\n---\np",
    )
  })

  test("Codex gets its auth file first, readable only by its owner, then its prompt on stdin", () => {
    const auth = Agents.environment("codex", "PLACEHOLDER", { account: ACCOUNT, now: NOW })
    const out = run(Agents.commandOf("codex", PROMPT, "gpt-6.1-sol"), auth)
    const provider = (baseUrl: string) =>
      `model_providers.smithers={name="ChatGPT",base_url="${baseUrl}",wire_api="responses",requires_openai_auth=true,supports_websockets=false}`
    expect(out).toBe(
      "exec\n--dangerously-bypass-approvals-and-sandbox\n--skip-git-repo-check\n-c\nmodel_provider=smithers\n-c\n" +
        `${provider("https://chatgpt.com/backend-api/codex")}\n--model\ngpt-6.1-sol\n-\n---\n${PROMPT}`,
    )
    expect(run(Agents.commandOf("codex", "p", undefined, "https://codex.example.com"), auth))
      .toContain(`-c\n${provider("https://codex.example.com")}\n-\n---\np`)
    const file = join(home, ".codex", "auth.json")
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ tokens: { access_token: "PLACEHOLDER" } })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(run(Agents.commandOf("codex", "p", undefined), auth)).not.toContain("--model")
  })
})

describe("environment", () => {
  test("Claude Code's holds only the placeholder, every call that isn't the model turned off", () => {
    const env = Agents.environment("claude-code", "PLACEHOLDER", { now: NOW })
    expect(env).toEqual({
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "PLACEHOLDER",
    })
    expect(Agents.environment("claude-code", "P", { now: NOW, baseUrl: null })).not.toHaveProperty("ANTHROPIC_BASE_URL")
  })

  test("a Claude subscription's base URL goes to ANTHROPIC_BASE_URL", () => {
    expect(Agents.environment("claude-code", "P", { now: NOW, baseUrl: "https://proxy.example.com" }))
      .toMatchObject({ ANTHROPIC_BASE_URL: "https://proxy.example.com", CLAUDE_CODE_OAUTH_TOKEN: "P" })
  })

  test("Codex's is its auth file, base64, and only that", () => {
    const env = Agents.environment("codex", "PLACEHOLDER", { account: ACCOUNT, now: NOW })
    expect(Object.keys(env)).toEqual(["SMITHERS_CODEX_AUTH"])
    expect(JSON.parse(atob(env["SMITHERS_CODEX_AUTH"]!))).toEqual(JSON.parse(Agents.codexAuth("PLACEHOLDER", ACCOUNT, NOW)))
  })
})

describe("codexAuth", () => {
  test("is what Codex reads: a placeholder access token, no refresh token of ours, and this run's own refresh time", () => {
    const auth = JSON.parse(Agents.codexAuth("PLACEHOLDER", ACCOUNT, NOW)) as Record<string, unknown>
    expect(auth).toEqual({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: Agents.idTokenOf(ACCOUNT),
        access_token: "PLACEHOLDER",
        refresh_token: "smithers-holds-it",
        account_id: "acct-1234",
      },
      last_refresh: "2026-10-31T12:00:00.000Z",
    })
  })

  test("its unsigned id token carries the same claims as OpenAI's, which our own reader reads back", () => {
    const token = Agents.idTokenOf(ACCOUNT)
    expect(token.split(".")).toHaveLength(3)
    expect(token).not.toMatch(/[=+/]/)
    expect(Codex.claimsOf(token)).toEqual(ACCOUNT)
  })
})

describe("reportOf", () => {
  test("Claude Code's JSON result: its summary and its token counts", () => {
    expect(Agents.reportOf("claude-code", `\n${JSON.stringify({ result: "Done.", usage: { input_tokens: 12, output_tokens: 34 } })}\n`))
      .toEqual({ summary: "Done.", inputTokens: 12, outputTokens: 34 })
  })

  test("a result without its fields is an empty summary and no counts", () => {
    expect(Agents.reportOf("claude-code", "{}")).toEqual({ summary: "", inputTokens: undefined, outputTokens: undefined })
  })

  test("Claude Code output that isn't JSON is the summary as it stands, trimmed and bounded", () => {
    expect(Agents.reportOf("claude-code", "  plain words\n")).toEqual({ summary: "plain words" })
    expect(Agents.reportOf("claude-code", "x".repeat(5_000)).summary).toHaveLength(4_000)
    expect(Agents.reportOf("claude-code", JSON.stringify({ result: "y".repeat(5_000) })).summary).toHaveLength(4_000)
  })

  test("Codex's last message is the summary", () => {
    expect(Agents.reportOf("codex", "  Done.\n")).toEqual({ summary: "Done." })
    expect(Agents.reportOf("codex", "z".repeat(5_000)).summary).toHaveLength(4_000)
  })
})
