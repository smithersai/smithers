import type { CodingAgent } from "../../src/features/personal-model/contract.ts"
import type { Credential } from "./Codex.ts"

// What running a vendor's own agent in a branch's box takes (decision 0132): the official Claude Code or Codex, unmodified,
// baked into the image (infra/sandbox/Dockerfile). The box holds a placeholder where the credential goes; the box's
// egress swaps it for the value, only toward the vendor's own hosts (worker/secrets/SandboxEgress.ts). This module
// knows each CLI's flags and files; nothing else in the app does.

/** The hosts a person's Claude subscription may be sent to, unless their connection names a base URL. */
export const CLAUDE_HOSTS: ReadonlyArray<string> = ["api.anthropic.com"]

/** The hosts a person's Codex subscription may be sent to. */
export const CODEX_HOSTS: ReadonlyArray<string> = ["chatgpt.com"]

/** Stops every call Claude Code makes that isn't the model, so the box's egress sees only `CLAUDE_HOSTS`. */
const CLAUDE_QUIET = {
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
} as const

/** The `base64url` of `text`. */
const base64url = (text: string) => btoa(text).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")

/**
 * The id token the box's Codex reads its plan and workspace from: the same claims as OpenAI's, unsigned, since it
 * checks no signature and sends this nowhere (codex-rs/login/src/token_data.rs `parse_chatgpt_jwt_claims`).
 */
export const idTokenOf = (account: Pick<Credential, "accountId" | "planType">) =>
  [
    base64url(JSON.stringify({ alg: "none", typ: "JWT" })),
    base64url(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: account.accountId, chatgpt_plan_type: account.planType },
    })),
    "unsigned",
  ].join(".")

/**
 * The `auth.json` the box's Codex reads. The access token is `placeholder`, the refresh token nothing: Codex refreshes
 * a token older than 8 days, and each run starts with a fresh file (`now`), so it never asks.
 */
export const codexAuth = (placeholder: string, account: Pick<Credential, "accountId" | "planType">, now: Date) =>
  JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idTokenOf(account),
      access_token: placeholder,
      refresh_token: "smithers-holds-it",
      account_id: account.accountId,
    },
    last_refresh: now.toISOString(),
  })

/** The environment a person's agent's commands run with, placeholders only. */
export const environment = (
  agent: Exclude<CodingAgent, "smithers">,
  placeholder: string,
  options: {
    readonly baseUrl?: string | null | undefined
    readonly account?: Pick<Credential, "accountId" | "planType"> | undefined
    readonly now: Date
  },
): Record<string, string> =>
  agent === "claude-code"
    ? {
      ...CLAUDE_QUIET,
      CLAUDE_CODE_OAUTH_TOKEN: placeholder,
      ...(options.baseUrl === undefined || options.baseUrl === null ? {} : { ANTHROPIC_BASE_URL: options.baseUrl }),
    }
    : { SMITHERS_CODEX_AUTH: btoa(codexAuth(placeholder, options.account!, options.now)) }

/** Where Codex sends a ChatGPT subscription's calls. */
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"

/**
 * Codex's own ChatGPT provider, over HTTP only: its default opens a WebSocket first, which the box's egress can't carry,
 * and retries it for minutes before it falls back.
 */
const codexProvider = (baseUrl: string) =>
  `-c model_provider=smithers -c ${quoted(
    `model_providers.smithers={name="ChatGPT",base_url="${baseUrl}",wire_api="responses",requires_openai_auth=true,supports_websockets=false}`,
  )}`

/** `text` as one shell word. */
const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * The shell command that runs `agent` on `prompt` in the checkout, its prompt on stdin so no process list shows it,
 * printing Claude Code's JSON result or Codex's last message. Unsupervised, as Amp's orbs run it: the box is the fence.
 */
export const commandOf = (
  agent: Exclude<CodingAgent, "smithers">,
  prompt: string,
  model: string | undefined,
  codexBaseUrl: string = CODEX_BASE_URL,
) => {
  const input = `printf %s ${quoted(btoa(unescape(encodeURIComponent(prompt))))} | base64 -d`
  const named = model === undefined ? "" : ` --model ${quoted(model)}`
  return agent === "claude-code"
    ? `${input} | claude -p --output-format json --dangerously-skip-permissions${named}`
    : [
      `umask 077 && mkdir -p "$HOME/.codex" && printf %s "$SMITHERS_CODEX_AUTH" | base64 -d >"$HOME/.codex/auth.json"`,
      `${input} | codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${codexProvider(codexBaseUrl)}${named} -`,
    ].join(" && ")
}

/** What a run of the agent reported: its summary, and the tokens Claude Code counts. */
export interface Report {
  readonly summary: string
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
}

/** The longest summary kept: one paragraph. */
const MAX_SUMMARY = 4_000

/** Reads what `agent` printed. Claude Code's result is JSON; a line that doesn't read is the summary as it stands. */
export const reportOf = (agent: Exclude<CodingAgent, "smithers">, stdout: string): Report => {
  const text = stdout.trim()
  if (agent === "claude-code") {
    try {
      const result = JSON.parse(text) as {
        readonly result?: unknown
        readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number }
      }
      return {
        summary: String(result.result ?? "").slice(0, MAX_SUMMARY),
        inputTokens: result.usage?.input_tokens,
        outputTokens: result.usage?.output_tokens,
      }
      // expected: output that isn't JSON is kept as it stands
    } catch {
      return { summary: text.slice(0, MAX_SUMMARY) }
    }
  }
  return { summary: text.slice(0, MAX_SUMMARY) }
}
