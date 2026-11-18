/**
 * Names the tool a failed command could not find.
 *
 * A shell reports a missing program in its own words and exits 127, and the
 * line that says so sits wherever the command's output put it. A target's
 * failure leads with the tool's name instead.
 *
 * @since 1.0.0
 */

/** How dash, bash, zsh, `env` and bubblewrap each say a program was not found. */
const reports: ReadonlyArray<RegExp> = [
  /(?:^|\n)[^\n]*?: (?:line \d+: |\d+: )?([^\s:]+): (?:command )?not found(?=\r?\n|$)/,
  /command not found: ([^\s:]+)/,
  /(?:^|\n)env: [‘'"]?([^’'"\n:]+)[’'"]?: No such file or directory/,
  /execvp ([^\s:]+): No such file or directory/
]

/**
 * The tool a command that exited 127 says it could not find, or nothing.
 *
 * @category diagnostics
 * @since 1.0.0
 */
export const named = (exitCode: number, output: string): string | undefined => {
  if (exitCode !== 127) return undefined
  for (const report of reports) {
    const name = report.exec(output)?.[1]
    if (name !== undefined) return name
  }
  return undefined
}

/**
 * The one line a target's failure leads with when its tool is missing.
 *
 * @category diagnostics
 * @since 1.0.0
 */
export const headline = (name: string): string =>
  `${name}: not found. No directory on PATH holds ${name}; install it or add its directory to PATH (exit 127)`
