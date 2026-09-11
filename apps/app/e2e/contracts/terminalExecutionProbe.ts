/**
 * Evidence that a terminal actually ran a command, not that the line
 * discipline echoed it back.
 *
 * The command prints the marker as two halves that `printf` joins, so the
 * marker never appears contiguously in the typed bytes: only a shell that
 * ran the command can emit it, and only on a line of its own. A check that
 * searches the stream for the typed command instead passes when Enter
 * delivery, the PTY, or the shell is broken.
 */
export interface TerminalExecutionProbe {
  /** The text the shell prints when it runs the command. */
  readonly marker: string
  /** The command to type into the terminal. */
  readonly command: string
  /** True when `text` carries the typed bytes, run or not; tolerates row wrapping. */
  readonly echoed: (text: string) => boolean
  /** True when `text` carries a standalone marker line, so the shell ran the command. */
  readonly executed: (text: string) => boolean
}

/** Row padding reaches the DOM as a non-breaking space. */
const plain = (text: string): string => text.replaceAll("\u00a0", " ")

const squeeze = (text: string): string => plain(text).replace(/\s+/g, "")

/**
 * Builds a probe from a hexadecimal run id of at least eight characters,
 * split in half so the halves are quoted apart in the command.
 *
 * @example
 * ```ts
 * const probe = terminalExecutionProbe("0123456789abcdef")
 * probe.executed("PTY_0123456789abcdef_OK") // true
 * ```
 */
export const terminalExecutionProbe = (id: string): TerminalExecutionProbe => {
  if (!/^[0-9a-z]{8,}$/.test(id)) {
    throw new Error(`A terminal probe id is at least eight lowercase alphanumerics, received ${JSON.stringify(id)}.`)
  }
  const half = Math.floor(id.length / 2)
  const head = `PTY_${id.slice(0, half)}`
  const tail = `${id.slice(half)}_OK`
  const marker = `${head}${tail}`
  const command = `printf '%s%s\\n' '${head}' '${tail}'`
  return {
    marker,
    command,
    echoed: (text) => squeeze(text).includes(squeeze(command)),
    executed: (text) => plain(text).split(/\r?\n/).some((line) => line.trim() === marker)
  }
}
