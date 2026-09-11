import * as fs from "node:fs"

export interface PtySpawnOptions {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly terminal: Bun.TerminalOptions
}

/** A failed start retains ownership until its new child has been reaped. */
export class PtySpawnError extends Error {
  readonly stopped: Promise<void>

  constructor(cause: unknown, process: ReturnType<typeof Bun.spawn>, gate: number | undefined) {
    super(`Could not start the terminal: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    // The target has not passed the EOF gate. Stop this child before closing
    // a gate whose first close failed, so cleanup cannot admit the command.
    try { process.kill("SIGKILL") } catch { /* Its exit remains authoritative. */ }
    if (gate !== undefined) {
      try { fs.closeSync(gate) } catch { /* The first close may already have closed it. */ }
    }
    this.stopped = process.exited.then(() => {
      try { process.terminal?.close() } catch { /* Bun may already have closed the terminal at exit. */ }
    })
    // The caller awaits this promise; attach immediately even if it handles
    // the error after the child's termination notification.
    void this.stopped.catch(() => {})
  }
}

// Read a token terminated by EOF, not a newline: the parent's control fd must
// be closed before the command can start. This private fd never uses the PTY.
const gateScript = 'IFS= read -r smithers_gate <&3; test "$smithers_gate" = start || exit 125; exec 3<&-; exec "$@"'

/** Spawn an already-composed sandbox argv without changing its arguments. */
export const spawnPty = (argv: ReadonlyArray<string>, options: PtySpawnOptions): ReturnType<typeof Bun.spawn> => {
  if (process.platform !== "darwin") return Bun.spawn([...argv], options)
  if (argv.length === 0 || Bun.which(argv[0]!, { cwd: options.cwd, PATH: options.env.PATH }) === null) {
    throw new Error(`Terminal executable was not found: ${argv[0] ?? "(empty command)"}`)
  }

  // Bun 1.4.1 can synchronously wait4 after macOS EVFILT_PROC registration
  // reports ESRCH for a rapidly exiting PTY child. A child waiting on fd3
  // stays alive until spawn returns and its process watch is installed.
  // This wrapper runs outside the fixed sandbox argv, then execs it intact.
  const child = Bun.spawn(["/bin/sh", "-c", gateScript, "smithers-pty", ...argv], {
    ...options,
    stdio: ["ignore", "ignore", "ignore", "socket-fd"]
  })
  const gate = child.stdio[3]
  try {
    if (typeof gate !== "number") throw new Error("The terminal start pipe was not available.")
    if (fs.writeSync(gate, "start") !== 5) throw new Error("The terminal start pipe did not accept its token.")
    fs.closeSync(gate)
  } catch (cause) {
    throw new PtySpawnError(cause, child, typeof gate === "number" ? gate : undefined)
  }
  return child
}
