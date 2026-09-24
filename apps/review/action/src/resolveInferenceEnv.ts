/**
 * Decides how the review subprocess reaches a model, in priority order:
 *
 * 1. A bring-your-own Anthropic key (`ANTHROPIC_API_KEY` in the caller's job
 *    env). Inference is billed to the repository owner and the seats stay on
 *    their defaults.
 * 2. A bring-your-own OpenAI key (`OPENAI_API_KEY`). The seats move to the
 *    `openai:` provider, because a seat's provider is the half of the string
 *    ahead of the colon and nothing else decides which key is read.
 * 3. The metered proxy (default). The service mints a session-scoped key and
 *    points `ANTHROPIC_BASE_URL` at its own origin.
 *
 * 0.x offered two subscription modes instead, one per CLI agent: it wrote the
 * repository owner's `~/.codex/auth.json` for the Codex CLI, or forwarded
 * `CLAUDE_CODE_OAUTH_TOKEN` to the Claude Code CLI. rc.0 runs no CLI
 * subprocess: a seat resolves to a provider route, so the credential is an API
 * key and there is nothing to materialize on disk.
 *
 * Publishing and quota are session-scoped and unaffected by this choice; only
 * inference moves off the proxy in the BYO modes.
 *
 * @since 1.0.0
 */

/**
 * What the caller's job environment offers.
 *
 * @since 1.0.0
 * @category models
 */
export interface ResolveInferenceEnvInput {
  anthropicBaseUrl: string;
  sessionToken: string;
  anthropicApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
}

/**
 * The chosen mode and the environment overrides that carry it.
 *
 * @since 1.0.0
 * @category models
 */
export interface ResolvedInferenceEnv {
  mode: "byo-anthropic" | "byo-openai" | "proxy";
  /** Env overrides for the review subprocess (merged over `process.env`). */
  env: Record<string, string>;
}

/**
 * The seats a BYO OpenAI key runs on, matching the Anthropic defaults' tiers.
 *
 * The review seat is `gpt-6-sol`, the GPT-6 workhorse; GPT-5.6 is never
 * selected. The cheap seat is `gpt-5.4-mini`, which `@smthrs/model` reports
 * OpenAI wire support for. `tests/action/resolveInferenceEnv.test.ts` pins
 * both. A seat string is never validated at resolve time: an unserved id
 * becomes a route that 404s on first use, and the two steps on the cheap seat
 * catch their own failure, so a typo here degrades the mode to "no narration,
 * no quiz" without a word in the log.
 */
const OPENAI_REVIEW_SEAT = "openai:gpt-6-sol";
const OPENAI_CHEAP_SEAT = "openai:gpt-5.4-mini";

/**
 * Chooses the inference mode.
 *
 * @since 1.0.0
 * @category constructors
 */
export function resolveInferenceEnv(input: ResolveInferenceEnvInput): ResolvedInferenceEnv {
  if (input.anthropicApiKey?.trim()) {
    return { mode: "byo-anthropic", env: { ANTHROPIC_API_KEY: input.anthropicApiKey.trim() } };
  }
  if (input.openaiApiKey?.trim()) {
    return {
      mode: "byo-openai",
      env: {
        OPENAI_API_KEY: input.openaiApiKey.trim(),
        SMITHERS_REVIEW_SEAT: OPENAI_REVIEW_SEAT,
        SMITHERS_REVIEW_CHEAP_SEAT: OPENAI_CHEAP_SEAT,
      },
    };
  }
  return {
    mode: "proxy",
    env: {
      ANTHROPIC_BASE_URL: input.anthropicBaseUrl,
      ANTHROPIC_API_KEY: input.sessionToken,
    },
  };
}
