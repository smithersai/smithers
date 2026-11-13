/**
 * Isolated review-process environment policy.
 * @since 1.0.0
 */

/**
 * Keeps only execution essentials and the selected engine's unwithheld credential.
 * @category environment
 * @since 1.0.0
 */
export const spawnEnvironment = (
  sensitiveEnv: ReadonlyArray<string>,
  git: boolean,
  home: string,
  engine: "claude" | "codex" | undefined,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  join: (...paths: Array<string>) => string
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    PATH: environment["PATH"] ?? "",
    HOME: home,
    TMPDIR: home,
    CLICOLOR: "0",
    FORCE_COLOR: "0",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1"
  }
  if (platform === "win32") {
    env["USERPROFILE"] = home
    if (environment["SystemRoot"] !== undefined) env["SystemRoot"] = environment["SystemRoot"]
  }
  const auth = engine === "claude" ?
    ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
    : engine === "codex"
    ? ["OPENAI_API_KEY", "CODEX_API_KEY"]
    : []
  for (const name of auth) {
    if (!sensitiveEnv.includes(name) && environment[name] !== undefined) env[name] = environment[name]
  }
  if (engine === "claude") env["CLAUDE_CONFIG_DIR"] = join(home, ".claude")
  if (engine === "codex") env["CODEX_HOME"] = join(home, ".codex")
  if (git) {
    env["GIT_CONFIG_GLOBAL"] = platform === "win32" ? "NUL" : "/dev/null"
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_PAGER"] = "cat"
    env["GIT_TERMINAL_PROMPT"] = "0"
  }
  return env
}
