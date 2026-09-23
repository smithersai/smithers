/**
 * `text:` in the Ctrl+K palette: ripgrep over the working directory in the
 * background. Literal unless a regex is given, capped, and cancellable. A
 * failure is a typed outcome for the caller to show; there is no fallback.
 * The spawn and process-group kill follow `shell.ts`.
 */
import { spawn } from "node:child_process"

export interface Hit {
  readonly path: string
  readonly line: number
  readonly text: string
}

export type Outcome =
  | { readonly _tag: "done"; readonly hits: ReadonlyArray<Hit>; readonly truncated: boolean }
  | { readonly _tag: "failed"; readonly reason: "missing-rg" | "bad-pattern" | "rg-error"; readonly message: string }
  | { readonly _tag: "cancelled" }

/** The most hits one search returns. */
export const limit = 200

export const run = (options: {
  readonly cwd: string
  readonly query: string
  /** `text:/re/`: search this pattern as a regex instead of `query` as a literal. */
  readonly regex?: string
  readonly limit?: number
  /** The rg binary; tests pass a missing or slow one. */
  readonly command?: string
}): { readonly done: Promise<Outcome>; readonly cancel: () => void } => {
  const cap = options.limit ?? limit
  const args = [
    "--null",
    "--line-number",
    "--no-heading",
    "--color", "never",
    "--smart-case",
    "--max-columns", "200",
    "--max-columns-preview",
    "--max-count", "20",
    ...(options.regex === undefined ? ["-F"] : []),
    "-e", options.regex ?? options.query,
    "--", "."
  ]
  const child = spawn(options.command ?? "rg", args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  })
  const hits: Array<Hit> = []
  let pending = ""
  let stderr = ""
  let settled = false
  let resolve: (outcome: Outcome) => void = () => {}
  const done = new Promise<Outcome>((settle) => {
    resolve = settle
  })
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
  }
  const finish = (outcome: Outcome) => {
    if (settled) return
    settled = true
    resolve(outcome)
  }
  const take = (line: string) => {
    // `path\0line:text`, so a colon in the path cannot split it.
    const nul = line.indexOf("\0")
    if (nul < 0) return
    const rest = line.slice(nul + 1)
    const colon = rest.indexOf(":")
    const number = Number(rest.slice(0, colon))
    if (colon < 0 || !Number.isInteger(number)) return
    hits.push({ path: line.slice(0, nul).replace(/^\.\//, ""), line: number, text: rest.slice(colon + 1) })
  }
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    if (settled) return
    pending += chunk
    const lines = pending.split("\n")
    pending = lines.pop()!
    for (const line of lines) {
      take(line)
      if (hits.length >= cap) {
        finish({ _tag: "done", hits, truncated: true })
        kill()
        return
      }
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  child.on("error", (error: NodeJS.ErrnoException) => {
    finish(
      error.code === "ENOENT"
        ? { _tag: "failed", reason: "missing-rg", message: "rg not found" }
        : { _tag: "failed", reason: "rg-error", message: error.message }
    )
  })
  child.on("close", (code) => {
    if (settled) return
    if (pending !== "") take(pending)
    if (code === 0 || code === 1) return finish({ _tag: "done", hits, truncated: false })
    const first = stderr.split("\n").find((line) => line.trim() !== "") ?? `rg exited with ${code}`
    finish(
      stderr.includes("regex parse error")
        ? { _tag: "failed", reason: "bad-pattern", message: (/^error: (.*)$/m.exec(stderr)?.[1] ?? first).trim() }
        : { _tag: "failed", reason: "rg-error", message: first }
    )
  })
  return {
    done,
    cancel: () => {
      if (settled) return
      finish({ _tag: "cancelled" })
      kill()
    }
  }
}
