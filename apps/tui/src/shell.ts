/**
 * `!command` and `!!command`: a shell command the person runs, not the agent.
 *
 * Output streams as it arrives with ANSI stripped. `!` puts the result in
 * the next turn's context using pi's template; `!!` keeps it out.
 */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
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

export const run = (options: {
  readonly command: string
  readonly cwd: string
  readonly onOutput: (text: string) => void
}): Running => {
  const shell = process.env.SHELL ?? "/bin/bash"
  const child = spawn(shell, ["-c", options.command], {
    cwd: options.cwd,
    env: { ...process.env, TERM: "dumb" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  })
  let full = ""
  let cancelled = false
  const receive = (chunk: Buffer) => {
    const text = clean(chunk.toString("utf8"))
    full += text
    options.onOutput(text)
  }
  child.stdout.on("data", receive)
  child.stderr.on("data", receive)
  const done = new Promise<Result>((resolve) => {
    const settle = (exitCode: number | null) => {
      const kept = tail(full)
      let fullOutputPath: string | undefined
      if (kept.truncated) {
        fullOutputPath = join(tmpdir(), `smithers-bash-${randomUUID()}.log`)
        writeFileSync(fullOutputPath, full)
      }
      resolve({
        command: options.command,
        output: kept.text.replace(/\n+$/, ""),
        exitCode,
        cancelled,
        ...(fullOutputPath === undefined ? {} : { fullOutputPath })
      })
    }
    child.on("close", (code) => settle(code))
    child.on("error", (error) => {
      full += `${error.message}\n`
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

/** What the agent reads about a `!` command (pi's `bashExecution` template). */
export const contextText = (result: Result): string => {
  let text = `Ran \`${result.command}\`\n\`\`\`\n${result.output === "" ? "(no output)" : result.output}\n\`\`\``
  if (result.cancelled) text += "\n\n(command cancelled)"
  else if (result.exitCode !== null && result.exitCode !== 0) text += `\n\nCommand exited with code ${result.exitCode}`
  if (result.fullOutputPath !== undefined) text += `\n\n[Output truncated. Full output: ${result.fullOutputPath}]`
  return text
}
