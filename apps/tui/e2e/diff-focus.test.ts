import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as poll } from "node:timers/promises"

import { bunPreload } from "./tmux.ts"

interface State {
  readonly frame: string
  readonly composer: string
  readonly prompts: ReadonlyArray<string>
}

test("native PTY preserves Esc then u in one write after a card diff", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-diff-burst-"))
  const stateFile = join(root, "state.json")
  const output: Array<Uint8Array> = []
  const child = Bun.spawn([
    process.execPath,
    "--preload",
    bunPreload,
    "--preload",
    join(import.meta.dir, "../src/native.ts"),
    join(import.meta.dir, "diff-focus-fixture.tsx")
  ], {
    cwd: root,
    env: {
      ...process.env,
      SMITHERS_REPO: "fixture/diff-focus",
      SMITHERS_TUI_SESSION_DIR: join(root, "sessions"),
      SMITHERS_DIFF_FOCUS_STATE: stateFile
    },
    terminal: { cols: 110, rows: 32, data: (_terminal, bytes) => output.push(bytes.slice()) }
  })
  const terminal = child.terminal!
  const states: Record<string, State> = {}
  const wait = async (name: string, predicate: (state: State) => boolean) => {
    const deadline = Date.now() + 5000
    let state: State | undefined
    while (Date.now() < deadline) {
      try {
        state = JSON.parse(readFileSync(stateFile, "utf8")) as State
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (state !== undefined && predicate(state)) {
        states[name] = state
        return state
      }
      if (child.exitCode !== null) {
        throw new Error(`Fixture exited ${child.exitCode}: ${Buffer.concat(output).toString()}`)
      }
      // Poll rendered state; input is sent only once that state exists.
      await poll(10)
    }
    throw new Error(`Missing ${name}: ${state?.frame}`)
  }
  try {
    await wait("initial", (state) => state.frame.includes("Review beta") && state.frame.includes("d Diff"))
    terminal.write("\t")
    await wait("selected", (state) => state.frame.includes("↑↓←→ Card"))
    terminal.write("d")
    await wait(
      "diff",
      (state) => state.frame.includes("Review beta  1 file") && state.frame.includes("beta.ts  +60 −60")
    )
    // Kitty Esc is unambiguous even when the next byte arrives in this same PTY write.
    expect(terminal.write("\x1b[27uu")).toBe(6)
    const confirmation = await wait("confirmation", (state) => state.frame.includes("Undo Review beta"))
    expect(confirmation.composer).toBe("")
    expect(confirmation.prompts).toEqual([])
    for (const id of ["alpha", "beta"]) {
      expect(readFileSync(join(root, "workspace", `${id}.ts`), "utf8")).toBe("new\n".repeat(60))
    }
    terminal.write("\x1b[27u")
    await wait("cancelled", (state) => !state.frame.includes("Undo Review beta"))
    terminal.write("ordinary u text")
    await wait("text", (state) => state.composer === "ordinary u text")
    terminal.write("\x03\x04")
    const deadline = Date.now() + 5000
    while (child.exitCode === null && Date.now() < deadline) await poll(10)
    expect(child.exitCode).not.toBeNull()
    expect(await child.exited).toBe(0)
  } finally {
    if (child.exitCode === null) {
      child.kill()
      await child.exited
    }
    terminal.close()
    const evidence = process.env.SMITHERS_DIFF_FOCUS_EVIDENCE
    if (evidence !== undefined) {
      writeFileSync(join(evidence, "pty-burst-states.json"), JSON.stringify(states, null, 2))
      writeFileSync(join(evidence, "pty-burst.raw"), Buffer.concat(output))
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)
