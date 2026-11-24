/**
 * `!command` and `!!command`: a shell command the person runs, not the agent.
 *
 * Output streams as it arrives with ANSI stripped. `!` puts the result in
 * the next turn's context using pi's template; `!!` keeps it out.
 */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { accessSync, appendFileSync, constants, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import * as Log from "./log.ts"
import * as Output from "./shell-output.ts"
import { stopGroup } from "./subprocess.ts"
import * as Timer from "./timer.ts"

/** The kept tail, and past it the full output goes to a file (pi's limits). */
export const maxLines = 2000
export const maxBytes = 50 * 1024
/** A full-output file stops here, with a marker, so a noisy command cannot fill the disk. */
export const maxSpillBytes = 10 * 1024 * 1024
/** Full-output files older than this are deleted when the next one is written. */
export const spillAgeMs = 24 * 60 * 60 * 1000
const spillName = /^smithers-bash-[0-9a-f-]{36}\.log$/

/** A session folder's full-output folder. */
export const spillFolder = (sessionFolder: string): string => join(sessionFolder, "spill")

/** Deletes this folder's full-output files older than `spillAgeMs`; best effort. */
export const prune = (dir: string, now = Date.now()): void => {
  let names: ReadonlyArray<string>
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!spillName.test(name)) continue
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > spillAgeMs) rmSync(path, { force: true })
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

export interface Result {
  readonly command: string
  readonly output: string
  readonly exitCode: number | null
  readonly cancelled: boolean
  /** Where the untruncated output went, when the tail was cut. */
  readonly fullOutputPath?: string
}

export interface Running {
  readonly done: Promise<Result>
  readonly cancel: () => void
}

/** `!!cmd` → excluded, `!cmd` → included, anything else → not a shell line. */
export const parse = (line: string): { readonly command: string; readonly excluded: boolean } | undefined => {
  if (line.startsWith("!!")) return { command: line.slice(2).trim(), excluded: true }
  if (line.startsWith("!")) return { command: line.slice(1).trim(), excluded: false }
  return undefined
}

/** Terminal output as plain text: escapes removed, carriage returns normalized. */
export const clean = Output.clean

/** The last `maxLines` lines within `maxBytes`, and whether anything was cut. */
export const tail = (text: string): { readonly text: string; readonly truncated: boolean } => {
  let lines = text.split("\n")
  let truncated = false
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines)
    truncated = true
  }
  let kept = lines.join("\n")
  if (Buffer.byteLength(kept) > maxBytes) {
    const bytes = Buffer.from(kept)
    let start = bytes.length - maxBytes
    while ((bytes[start]! & 0xc0) === 0x80) start++
    kept = bytes.subarray(start).toString("utf8")
    kept = kept.slice(kept.indexOf("\n") + 1)
    truncated = true
  }
  return { text: kept, truncated }
}

/**
 * Masks the values of credential-named environment variables. The command
 * runs with the person's own environment, but its output is shown, saved to
 * the session and, for `!`, sent to the model.
 */
export const redact = Output.redact

/** Ends a full-output file cut at `maxSpillBytes`. */
const spillCut = `\n[output cut at ${maxSpillBytes / 1024 / 1024} MiB]\n`

/** Output kept in memory while a command runs; past it, only the tail stays and the rest streams to a file. */
const memory = 4 * maxBytes
/** Output reaches the screen at most this often. */
export const flushMs = 50
/** Give a stopped command time to clean up before killing its remaining process group. */
export const cancelGraceMs = 1000

/** Bash from PATH, when SHELL names no shell. */
const bashOnPath = (path: string | undefined): string | undefined => {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue
    const candidate = join(dir, "bash")
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here or not executable: try the next PATH entry.
    }
  }
  return undefined
}

export const run = (options: {
  readonly command: string
  readonly cwd: string
  readonly onOutput: (text: string) => void
  readonly env?: NodeJS.ProcessEnv
  /**
   * Where over-limit output goes, created owner-only; the temp directory
   * unless the caller says otherwise. Older full-output files there are pruned.
   */
  readonly spillDir?: string
  /** `false` keeps only the tail and writes no file: a monitor's repeated observation. */
  readonly spill?: boolean
}): Running => {
  const env = options.env ?? process.env
  const shell = env.SHELL || bashOnPath(env.PATH) || "/bin/sh"
  const child = spawn(shell, ["-c", options.command], {
    cwd: options.cwd,
    env: { ...env, TERM: "dumb" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  })
  let kept = ""
  let bytes = 0
  let spill: string | undefined
  let unwritable = options.spill === false
  let spilled = 0
  /** The full-output file reached `maxSpillBytes` and ends with its marker. */
  let capped = false
  let pending = ""
  let timer: Timer.Cancel | undefined
  let cancelled = false
  let settled = false
  let stopping: Promise<void> | undefined
  const spillDir = options.spillDir ?? tmpdir()
  /** A new full-output file holding `text`, capped at `maxSpillBytes`. */
  const open = (text: string): string | undefined => {
    const path = join(spillDir, `smithers-bash-${randomUUID()}.log`)
    const ok = written(() => {
      if (options.spillDir !== undefined) mkdirSync(spillDir, { recursive: true, mode: 0o700 })
      prune(spillDir)
      writeFileSync(path, "", { mode: 0o600 })
    })
    if (!ok) return undefined
    spill = path
    if (!append(text)) return undefined
    return path
  }
  /** Appends within the cap; past it, one marker and nothing more. */
  const append = (text: string): boolean => {
    if (spill === undefined || capped || text === "") return true
    const room = maxSpillBytes - spilled
    const bytes = Buffer.from(text)
    capped = bytes.length > room
    const ok = written(() =>
      appendFileSync(spill!, capped ? Buffer.concat([bytes.subarray(0, room), Buffer.from(spillCut)]) : bytes)
    )
    spilled += Math.min(bytes.length, room)
    if (!ok) {
      spill = undefined
      unwritable = true
    }
    return ok
  }
  /** A full-output file that cannot be written costs only the file; the command and its tail go on. */
  const written = (write: () => void): boolean => {
    try {
      write()
      return true
    } catch {
      return false
    }
  }
  const flush = () => {
    timer?.()
    timer = undefined
    if (pending === "") return
    const text = pending
    pending = ""
    options.onOutput(text)
  }
  const receive = (text: string) => {
    if (text === "") return
    bytes += Buffer.byteLength(text)
    if (spill === undefined && bytes > maxBytes && !unwritable) {
      if (open(kept + text) === undefined) unwritable = true
    } else if (spill !== undefined) append(text)
    kept = (kept + text).slice(-memory)
    if (kept.charCodeAt(0) >= 0xdc00 && kept.charCodeAt(0) <= 0xdfff) kept = kept.slice(1)
    pending += text
    timer ??= Timer.after(flushMs, flush)
  }
  // One redactor per stream: a held secret prefix on stdout must never be joined to stderr's next chunk.
  const redactor = Output.redactor(env)
  const streams = [child.stdout, child.stderr].map((pipe) => {
    const decoder = Output.decoder()
    const own = Output.redactor(env)
    pipe.on("data", (chunk: Buffer) => receive(own.write(decoder.write(chunk))))
    pipe.on("end", () => receive(own.write(decoder.end()) + own.end()))
    return own
  })
  const done = new Promise<Result>((resolve) => {
    const settle = async (exitCode: number | null) => {
      if (settled) return
      settled = true
      await stopping
      for (const own of [...streams, redactor]) receive(own.end())
      flush()
      const cut = tail(kept)
      if (cut.truncated && spill === undefined && !unwritable) open(kept)
      const fullOutputPath = spill
      resolve({
        command: options.command,
        output: cut.text.replace(/\n+$/, ""),
        exitCode,
        cancelled,
        ...(fullOutputPath === undefined ? {} : { fullOutputPath })
      })
    }
    child.on("close", (code) => settle(code))
    child.on("error", (error: NodeJS.ErrnoException) => {
      Log.write("shell.spawn", error)
      receive(redactor.write(clean(`${error.code === "ENOENT" ? `${shell} not found` : `${shell} could not start`}\n`)))
      settle(127)
    })
  })
  return {
    done,
    cancel: () => {
      if (settled || cancelled) return
      cancelled = true
      if (child.pid !== undefined) {
        stopping = stopGroup(child.pid, cancelGraceMs).catch((error) => {
          Log.write("shell.stop", error)
          receive(redactor.write(clean("Could not stop the command.\n")))
        })
      }
    }
  }
}

/** What a session file keeps: a `!!` command's output stays out, like it stays out of the context. */
export const persisted = (result: Result, excluded: boolean): Result => {
  if (!excluded) return result
  const { fullOutputPath: _path, ...rest } = result
  return { ...rest, output: "" }
}

/** What the agent reads about a `!` command (pi's `bashExecution` template). */
export const contextText = (result: Result): string => {
  let text = `Ran \`${result.command}\`\n\`\`\`\n${result.output === "" ? "(no output)" : result.output}\n\`\`\``
  if (result.cancelled) text += "\n\n(command cancelled)"
  else if (result.exitCode !== null && result.exitCode !== 0) text += `\n\nCommand exited with code ${result.exitCode}`
  if (result.fullOutputPath !== undefined) text += `\n\n[Output truncated. Full output: ${result.fullOutputPath}]`
  return text
}
