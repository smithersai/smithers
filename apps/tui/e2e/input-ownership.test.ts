import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { drawn, key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

test("80x24 input survives concurrent flow discovery without listener warnings", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-input-pty-"))
  for (const directory of ["home", "bin", ".smithers/flows/review"]) {
    mkdirSync(join(root, directory), { recursive: true })
  }
  // Branch display is immaterial here; the fixture never invokes the Git CLI.
  writeFileSync(join(root, "bin", "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  writeFileSync(join(root, ".smithers", "flows", "review", "flow.mdx"), "---\ndescription: Review\n---\nAnswer only.\n")
  const nodeEntry = process.env.SMITHERS_TUI_INPUT_NODE_ENTRY
  const command = nodeEntry === undefined
    ? `bun --preload ${quote(join(import.meta.dir, "input-ownership-preload.mjs"))} ${
      quote(join(app, "src", "main.tsx"))
    }`
    : `node --experimental-ffi --import ${quote(join(import.meta.dir, "input-ownership-preload.mjs"))} ${
      quote(nodeEntry)
    }`
  try {
    for (const [index, exitKey] of [key.ctrlD, key.ctrlC + key.ctrlC].entries()) {
      // One receipt per launch: a stale file from the previous launch would
      // otherwise satisfy these assertions for a process that wrote nothing.
      const receipt = join(root, `receipt-${index}.json`)
      const tui = await Tui.start({
        cwd: root,
        cols: 80,
        rows: 24,
        command: `${command} ${quote(root)}`,
        env: {
          PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
          HOME: join(root, "home"),
          SMITHERS_TUI_SESSION_DIR: join(root, "sessions"),
          SMITHERS_TUI_REPLAY: join(app, "test", "fixtures", "fix-add.jsonl"),
          SMITHERS_TUI_INPUT_RECEIPT: receipt
        }
      })
      try {
        await tui.until(drawn, 20_000, "first draw")
        // One PTY write: focus transitions must apply before later command bytes.
        await tui.press("/flows\r".repeat(16))
        await tui.until((screen) => screen.includes("Flows") && screen.includes("review"), 5_000, "flow list")
        await tui.press(key.escape)
        await tui.until(drawn, 5_000, "composer")
        await tui.press("burst3702-😀")
        await tui.until((screen) => screen.includes("burst3702-😀"), 5_000, "ordered keyboard burst")
        expect(tui.alive).toBe(true)
        // Clear must work in raw mode; Ctrl+D then exits only from an empty editor.
        await tui.press(key.ctrlC)
        await tui.until((screen) => !screen.includes("burst3702"), 5_000, "clear editor")
        expect(tui.alive).toBe(true)
        await new Promise((resolve) => setTimeout(resolve, 600))
        await tui.press(exitKey)
        expect(await tui.waitForExit(8_000)).toEqual({ code: 0 })
        const observed = JSON.parse(readFileSync(receipt, "utf8"))
        expect(observed.warnings.filter((warning: { name: string }) => warning.name === "MaxListenersExceededWarning"))
          .toEqual([])
        // Two: Node's own stream listener and this preload's. The leak reached
        // eleven, so a bound well under the limit of ten keeps the margin visible.
        expect(observed.peakEnd).toBeLessThanOrEqual(4)
        expect(observed.rawSeen).toBe(true)
        expect(observed.raw).toBe(false)
        expect(observed.unrelated).toBe(true)
      } finally {
        await tui.stop()
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)
