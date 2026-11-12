import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bunCommand, exitOf, nudge, Tui } from "./tmux.ts"

describe("exitOf", () => {
  it("reports a live pane as running", () => {
    expect(exitOf("0::")).toBeUndefined()
  })

  // tmux marks a pane dead at PTY EOF, which can precede reaping its process.
  it("waits for the status of a pane that closed its terminal before it was reaped", () => {
    expect(exitOf("1::")).toBeUndefined()
  })

  it("reports the exit status and a signal death", () => {
    expect(exitOf("1:0:")).toEqual({ code: 0 })
    expect(exitOf("1:3:")).toEqual({ code: 3 })
    expect(exitOf("1::1")).toEqual({ code: null, signal: 1 })
  })
})

describe("nudge", () => {
  it("does nothing for a pid tmux did not print or a server that is gone", () => {
    expect(() => nudge(Number.NaN)).not.toThrow()
    expect(() => nudge(0)).not.toThrow()
    const gone = Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim()
    expect(() => nudge(Number(gone))).not.toThrow()
  })
})

describe("a pane's liveness", () => {
  it("is alive while its process runs and not alive once it exits, reaped or not", async () => {
    const tui = await Tui.start({ cwd: tmpdir(), command: "sh -c 'read line; exit 3'" })
    try {
      expect(tui.alive).toBe(true)
      expect(tui.exited).toBeUndefined()
      await tui.press("go\r")
      expect(await tui.waitForExit()).toEqual({ code: 3 })
      expect(tui.alive).toBe(false)
    } finally {
      tui.dispose()
    }
  }, 20_000)
})

it("loads migrated runtime exports from a project outside the repository", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tui-vibe project's-"))
  const probe = join(directory, "runtime probe.mjs")
  const receipt = join(directory, "runtime receipt.json")
  const preload = join(directory, "fixture preload.mjs")
  writeFileSync(preload, "globalThis.fixturePreload = true;")

  const replacement =
    new URL("../../../packages/smithers/flows/platform-bun/src/BunFileReplacement.vibe", import.meta.url).href
  const trace = new URL("../../../packages/smithers/flows/engine/src/StepTrace.vibe", import.meta.url).href
  writeFileSync(
    probe,
    [
      "import { writeFileSync } from 'node:fs';",
      "import { FileChanged } from " + JSON.stringify(replacement) + ";",
      "import { observed } from " + JSON.stringify(trace) + ";",
      "console.log('runtime exports', typeof FileChanged, typeof observed);",
      "if (typeof FileChanged !== 'function' || typeof observed !== 'function' || globalThis.fixturePreload !== true) process.exit(3);",
      "writeFileSync(" + JSON.stringify(receipt) +
      ", JSON.stringify([typeof FileChanged, typeof observed, globalThis.fixturePreload]));"
    ].join("\n")
  )
  const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  const tui = await Tui.start({
    cwd: directory,
    command: bunCommand + " --preload " + shellQuote(preload) + " " + shellQuote(probe)
  })
  try {
    const exit = await tui.waitForExit(30_000)
    expect(exit).toEqual({ code: 0 })
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(["function", "function", true])
  } finally {
    tui.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
}, 40_000)
