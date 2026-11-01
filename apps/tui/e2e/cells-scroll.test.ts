import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { key, Tui } from "./tmux.ts"

const fixture = fileURLToPath(new URL("./cells-scroll-fixture.tsx", import.meta.url))
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
const toggle = async (tui: Tui) => {
  await tui.type("/filter")
  await tui.press(key.enter)
  await tui.until((screen) => screen.includes("Filter chat"))
  await tui.type("Cells")
  await tui.press(key.down + key.enter)
  await tui.press(key.escape)
  await tui.until((screen) => !screen.includes("Filter chat"))
}
/** The turn a visible message line belongs to, as the fixture numbers them. */
const turnOf = (line: string) => Number(/(?:Question|Answer|Detail) (\d+)/.exec(line)![1])
const firstMessage = (screen: string) =>
  screen.split("\n").find((line) => /Question \d+|Answer \d+|Detail \d+:\d+/.test(line))
const receipt = async (tui: Tui, name: string) => {
  const prefix = process.env.SMITHERS_CELLS_SCROLL_RECEIPT
  if (prefix === undefined) return
  writeFileSync(`${prefix}-${name}.txt`, tui.screen())
  writeFileSync(`${prefix}-${name}.html`, await tui.html())
}

test("Cells preserves older messages and the live tail through an 80x24 PTY", async () => {
  const root = mkdtempSync(join(tmpdir(), "cells-scroll-"))
  const cwd = join(root, "workspace")
  mkdirSync(cwd)
  const tui = await Tui.start({
    command: `${quote(process.execPath)} ${quote(fixture)}`,
    cwd,
    rows: 24,
    cols: 80,
    env: { SMITHERS_TUI_SESSION_DIR: join(root, "sessions") }
  })
  try {
    await tui.until((screen) => screen.includes("Detail 19:4"))
    await tui.press("\x1b[5~".repeat(5))
    const before = tui.screen().split("\n")
    const row = before.findIndex((line) => /Question \d+|Answer \d+|Detail \d+:\d+/.test(line))
    const anchor = before[row]!.trim()
    expect(anchor).not.toContain("19")
    await receipt(tui, "before")
    for (let index = 0; index < 4; index++) {
      await toggle(tui)
      await receipt(tui, `toggle-${index}`)
      const at = tui.screen().split("\n").findIndex((line) => line.trim() === anchor)
      expect(at).toBeGreaterThan(0)
      expect(Math.abs(at - row)).toBeLessThanOrEqual(1)
    }
    await tui.type("Draft still works")
    expect(tui.screen()).toContain("Draft still works")
    await tui.press(key.ctrlC)
    await tui.press("\x1b[6~".repeat(100))
    await tui.until((screen) => screen.includes("Detail 19:4"))
    for (let index = 0; index < 4; index++) {
      await toggle(tui)
      await receipt(tui, `tail-${index}`)
      expect(tui.screen()).toContain("Detail 19:4")
    }
    await tui.type("Check input")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Input received"))
    await receipt(tui, "input")
  } finally {
    tui.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test.each(["\x1b[5~", "\x1b[6~"])(
  "Ctrl+O followed by %j and draft bytes in one PTY write keeps newer navigation",
  async (page) => {
    const root = mkdtempSync(join(tmpdir(), "cells-burst-"))
    const cwd = join(root, "workspace")
    mkdirSync(cwd)
    const tui = await Tui.start({
      command: `${quote(process.execPath)} ${quote(fixture)}`,
      cwd,
      rows: 24,
      cols: 80,
      env: { SMITHERS_TUI_SESSION_DIR: join(root, "sessions") }
    })
    const name = page === "\x1b[5~" ? "pageup" : "pagedown"
    try {
      await tui.until((screen) => screen.includes("Detail 19:4"))
      await tui.press("\x1b[5~".repeat(5))
      const anchor = firstMessage(tui.screen())!.trim()
      await receipt(tui, `burst-${name}-before`)
      // The native stdin parser receives the disclosure key, both page keys
      // and the draft together; no settling wait separates their handling.
      await tui.press(key.ctrlO + page.repeat(2) + "Burst draft")
      await tui.until((screen) => screen.includes("Burst draft"))
      await receipt(tui, `burst-${name}-after`)
      expect(tui.screen()).toContain("const cell")
      expect(tui.screen().split("\n").some((line) => line.trim() === anchor)).toBe(false)
      expect(tui.screen()).toContain("Burst draft")
      // The reader keeps their place in a real terminal: the settled view is
      // the two page keys they asked for from the turn they left, not the top
      // or the tail a dozen turns away.
      await tui.until(
        (screen) => {
          const line = firstMessage(screen)
          return line !== undefined && Math.abs(turnOf(line) - turnOf(anchor)) <= 4
        },
        4_000,
        `within four turns of ${anchor}`
      )
      await receipt(tui, `burst-${name}-settled`)
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("Input received"))
      await receipt(tui, `burst-${name}-sent`)
    } finally {
      tui.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  },
  20_000
)
