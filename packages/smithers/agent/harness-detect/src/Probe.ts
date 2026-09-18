/**
 * What a version or model probe may read, and how its output is read back.
 *
 * The spawning itself belongs to the runtime adapter that implements
 * {@link HarnessHost.version}; these are the two decisions that must be the
 * same wherever it runs — the environment a probe child is allowed to see,
 * and the version string parsed out of whatever banner the CLI prints.
 *
 * @since 0.1.0
 */

/**
 * How long one `--version` may take before it is reported as null.
 *
 * @category constants
 * @since 0.1.0
 */
export const VERSION_TIMEOUT_MS = 3000

/**
 * The version out of a CLI's banner: "2.1.247 (Claude Code)" -> "2.1.247";
 * "crush version v0.1.11" -> "0.1.11"; else the first non-empty line.
 *
 * @category probe
 * @since 0.1.0
 */
export const parseVersionLine = (output: string): string | null => {
  const firstLine = output.split("\n").map((line) => line.trim()).find((line) => line !== "")
  if (firstLine === undefined) return null
  const match = /\d+\.\d+(?:\.\d+)?[0-9A-Za-z.+-]*/.exec(firstLine)
  return match === null ? firstLine : match[0]
}

/**
 * The environment a probe child gets: these keys and nothing else, so a
 * session token (SMITHERS_CLOUD_TOKEN, GITHUB_TOKEN) never reaches a CLI
 * that only reports its version or its models.
 *
 * @category constants
 * @since 0.1.0
 */
export const PROBE_ENV_KEYS = [
  // Resolving the binary, its interpreter (`#!/usr/bin/env node`) and its own config.
  "HOME",
  "PATH",
  "TMPDIR",
  // Output encoding.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Where opencode keeps its config, auth.json and model cache.
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_CONFIG",
  // `opencode models` lists a provider only when its credential is present; these are the ones DETECTORS reads.
  "OPENCODE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENROUTER_API_KEY"
] as const

/**
 * The probe child environment: {@link PROBE_ENV_KEYS} from `source`, plus
 * `NO_COLOR`.
 *
 * @category probe
 * @since 0.1.0
 */
export const probeEnv = (source: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const env: Record<string, string> = { NO_COLOR: "1" }
  for (const key of PROBE_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined && value !== "") env[key] = value
  }
  return env
}
