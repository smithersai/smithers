import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { key, Tui } from "./zmux.ts"

it("renders a bound main tree beside chat and keeps the composer typing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-main-"))
  const tui = await Tui.start({ command: `${Bun.which("bun")!} ${join(import.meta.dir, "main-view-fixture.tsx")}`, cwd, rows: 50, cols: 160 })
  try {
    await tui.until((screen) => screen.includes("Ask Smithers"))
    await tui.type("review this repo")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Agent package") && screen.includes("TUI app") && screen.includes("Chat"), 15_000)
    await tui.type("follow up")
    const screen = await tui.until((screen) => screen.includes("follow up"))
    const lines = screen.split("\n")
    expect(lines.some((line) => line.includes("Recursive review") && line.includes("Chat"))).toBe(true)
    expect(lines.some((line) => line.includes("Agent package"))).toBe(true)
    const html = join(cwd, "main-view.html")
    const png = "/Users/williamcory/Desktop/smithers-tui-orchestration-20260923/lanes/C/main-view.png"
    writeFileSync(html, tui.html())
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    const result = spawnSync(chrome, ["--headless", "--disable-gpu", "--no-sandbox", `--window-size=2100,1000`, `--screenshot=${png}`, `file://${html}`], { encoding: "utf8" })
    expect(result.status).toBe(0)
    await tui.press(key.ctrlBackslash)
    await tui.until((screen) => screen.includes("Chat") && !screen.includes("Review in progress."))
  } finally {
    await tui.stop()
  }
}, 60_000)
