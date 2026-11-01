/**
 * The answer region is never blank at 80x24 while an available answer waits on
 * the syntax worker (#3699). The fixture holds the real worker's reply and
 * reports each native frame, so the held frames are receipts, not a race.
 */
import { expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { drawn, key, Tui } from "./tmux.ts"

const fixture = join(resolve(import.meta.dir, ".."), "e2e", "answer-frames-fixture.tsx")
const available = "PTY available answer"

interface Frame {
  readonly available: boolean
  readonly released: boolean
  readonly highlighted: boolean
  readonly chars: string
}

const frames = (root: string): ReadonlyArray<Frame> => {
  const file = join(root, "frames.jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8").split("\n").filter((line) => line.endsWith("}")).map((line) =>
    JSON.parse(line) as Frame
  )
}
const held = (list: ReadonlyArray<Frame>): ReadonlyArray<Frame> =>
  list.filter((frame) => frame.available && !frame.released)

/** Waits on frame receipts and never on answer text, so a blank frame still ends the wait. */
const receipts = async (
  root: string,
  predicate: (list: ReadonlyArray<Frame>) => boolean,
  label: string
): Promise<ReadonlyArray<Frame>> => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const list = frames(root)
    if (predicate(list)) return list
    await new Promise((settle) => setTimeout(settle, 50))
  }
  throw new Error(`Timeout awaiting ${label}`)
}

it("draws an available answer in every held native 80x24 frame", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-answer-frames-"))
  let tui: Tui | undefined
  try {
    tui = await Tui.start({
      cwd: root,
      cols: 80,
      rows: 24,
      command: `bun ${fixture}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_ANSWER_FRAMES_DIR: root,
        SMITHERS_TUI_SESSION_DIR: join(root, "sessions")
      }
    })
    await tui.until(drawn, 30_000, "first draw")
    await tui.type("Offline question")
    await tui.press(key.enter)
    await receipts(root, (list) => list.some((frame) => frame.chars.includes("Steer,")), "unresolved turn receipt")
    writeFileSync(join(root, "answer"), "")
    await receipts(root, (list) => held(list).length >= 1, "an available frame receipt while syntax is held")
    // Ordinary composer keys force further frames while the worker stays held.
    await tui.type("x")
    await tui.press(key.backspace)
    const waiting = held(await receipts(root, (list) => held(list).length >= 3, "successive held frame receipts"))
    for (const frame of waiting) expect(frame.chars).toContain(available)
    writeFileSync(join(root, "release"), "")
    const replied = await receipts(
      root,
      (list) => list.filter((frame) => frame.available && frame.highlighted).length >= 2,
      "frame receipts after the real syntax reply"
    )
    const last = replied.filter((frame) => frame.available && frame.highlighted).at(-1)!
    expect(last.chars).toContain(available)
    expect(last.chars).not.toContain("**")
    // Eventual terminal check, downstream of the frame receipts above.
    await tui.until((screen) => screen.includes(`${available} with bold and code.`), 20_000, "answer on the terminal")
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
