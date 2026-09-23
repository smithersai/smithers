/**
 * `!command` and `!!command`: a shell command the person runs, not the agent.
 *
 * Output streams as it arrives with ANSI stripped. `!` puts the result in
 * the next turn's context using pi's template; `!!` keeps it out.
 */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The kept tail, and past it the full output goes to a file (pi's limits). */
export const maxLines = 2000
export const maxBytes = 50 * 1024

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

// CSI, OSC and single-character escapes.
const ansi = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** Terminal output as plain text: escapes removed, carriage returns normalized. */
export const clean = (text: string): string => text.replace(ansi, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")

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
    kept = Buffer.from(kept).subarray(-maxBytes).toString("utf8")
    kept = kept.slice(kept.indexOf("\n") + 1)
    truncated = true
  }
  return { text: kept, truncated }
}

/** An environment variable whose value is a credential by its name. */
const secretName = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH/i

/**
 * Masks the values of credential-named environment variables. The command
 * runs with the person's own environment, but its output is shown, saved to
 * the session and, for `!`, sent to the model.
 */
export const redact = (text: string, env: NodeJS.ProcessEnv = process.env): string => {
  let masked = text
  const secrets = Object.entries(env)
    .flatMap(([name, value]) => (secretName.test(name) && value !== undefined && value.length >= 8 ? [[name, value] as const] : []))
    .sort((a, b) => b[1].length - a[1].length)
  for (const [name, value] of secrets) masked = masked.split(value).join(`[redacted $${name}]`)
  return masked
}

/** Output kept in memory while a command runs; past it, only the tail stays and the rest streams to a file. */
const memory = 4 * maxBytes
/** Output reaches the screen at most this often. */
export const flushMs = 50

export const run = (options: {
  readonly command: string
  readonly cwd: string
  readonly onOutput: (text: string) => void
  readonly env?: NodeJS.ProcessEnv
}): Running => {
  const env = options.env ?? process.env
  const shell = env.SHELL ?? "/bin/bash"
  const child = spawn(shell, ["-c", options.command], {
    cwd: options.cwd,
    env: { ...env, TERM: "dumb" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  })
  let kept = ""
  let bytes = 0
  let spill: string | undefined
  let pending = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (pending === "") return
    const text = pending
    pending = ""
    options.onOutput(text)
  }
  const receive = (chunk: Buffer | string) => {
    const text = redact(clean(chunk.toString()), env)
    bytes += Buffer.byteLength(text)
    if (spill === undefined && bytes > maxBytes) {
      spill = join(tmpdir(), `smithers-bash-${randomUUID()}.log`)
      writeFileSync(spill, kept + text, { mode: 0o600 })
    } else if (spill !== undefined) appendFileSync(spill, text)
    kept = (kept + text).slice(-memory)
    pending += text
    timer ??= setTimeout(flush, flushMs)
  }
  child.stdout.on("data", receive)
  child.stderr.on("data", receive)
  const done = new Promise<Result>((resolve) => {
    let settled = false
    const settle = (exitCode: number | null) => {
      if (settled) return
      settled = true
      flush()
      const cut = tail(kept)
      let fullOutputPath = spill
      if (cut.truncated && fullOutputPath === undefined) {
        fullOutputPath = join(tmpdir(), `smithers-bash-${randomUUID()}.log`)
        writeFileSync(fullOutputPath, kept, { mode: 0o600 })
      }
      resolve({
        command: options.command,
        output: cut.text.replace(/\n+$/, ""),
        exitCode,
        cancelled,
        ...(fullOutputPath === undefined ? {} : { fullOutputPath })
      })
    }
    child.on("close", (code) => settle(code))
    child.on("error", (error) => {
      receive(`${error.message}\n`)
      settle(127)
    })
  })
  return {
    done,
    cancel: () => {
      cancelled = true
      // The whole process group, so `sleep` under `sh -c` dies with it.
      try {
        process.kill(-child.pid!, "SIGTERM")
      } catch {
        child.kill("SIGTERM")
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
