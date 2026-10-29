import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const fixture = fileURLToPath(new URL("./fixtures/restart-uncaptured.ts", import.meta.url))

const incarnation = (directory: string, phase: string, variant: string) => {
  const child = spawn(process.execPath, [fixture, directory, phase, variant], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SMITHERS_BACKEND: "sqlite", SMITHERS_POSTGRES_URL: "", DATABASE_URL: "" }
  })
  let output = ""
  let errors = ""
  let announce = () => {}
  const effect = new Promise<void>((resolve) => {
    announce = resolve
  })
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk
    if (output.includes("EFFECT=B\n")) announce()
  })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    errors += chunk
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
  void exited.finally(() => clearTimeout(timer))
  return { child, effect, exited, output: () => output, errors: () => errors }
}

it.each(
  [
    ["single", "SIGKILL", "single", false],
    ["plain", "SIGKILL", "plain", false],
    ["plain", "SIGTERM", "plain", false],
    ["plain", "SIGKILL", "edited-body", true],
    ["plain", "SIGKILL", "commented-body", false],
    ["captured", "SIGKILL", "captured", false],
    ["typed-catch", "SIGKILL", "typed-catch", false],
    ["continuation", "SIGKILL", "continuation", false],
    ["continuation", "SIGKILL", "edited-continuation", true],
    ["continuation", "SIGKILL", "commented-continuation", false]
  ] as const
)("resumes %s after %s with %s (changed=%s)", async (variant, signal, resumedVariant, changed) => {
  const directory = mkdtempSync(join(tmpdir(), "flows-restart-"))
  const first = incarnation(directory, "start", variant)
  let second: ReturnType<typeof incarnation> | undefined
  try {
    await Promise.race([
      first.effect,
      first.exited.then((exit) => {
        throw new Error(`exited before B: ${JSON.stringify(exit)}\n${first.errors()}`)
      })
    ])
    expect(readFileSync(join(directory, "effects.log"), "utf8")).toBe(variant === "single" ? "B\n" : "A\nB\n")
    expect(first.child.kill(signal)).toBe(true)
    const killed = await first.exited
    if (signal === "SIGKILL") expect(killed.signal).toBe("SIGKILL")
    second = incarnation(directory, "resume", resumedVariant)
    const resumed = await second.exited
    if (changed) {
      expect(resumed.code).not.toBe(0)
      expect(second.errors()).toContain("The rebuilt plan differs from the recorded plan")
      expect(readFileSync(join(directory, "effects.log"), "utf8")).toBe("A\nB\n")
    } else {
      expect(resumed.code, second.errors()).toBe(0)
      const expected = variant === "single" ? "single" : variant === "typed-catch" ? "recovered" : "first"
      expect(second.output()).toContain(`RESULT=${JSON.stringify(expected)}`)
      expect(readFileSync(join(directory, "effects.log"), "utf8")).toBe(variant === "single" ? "B\nB\n" : "A\nB\nB\n")
    }
  } finally {
    first.child.kill("SIGKILL")
    second?.child.kill("SIGKILL")
    await first.exited
    if (second) await second.exited
    rmSync(directory, { recursive: true, force: true })
  }
}, 130_000)
