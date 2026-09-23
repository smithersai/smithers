/** Color screenshots of the tab strip, worker view and sidebar: `bun e2e/shots.ts <out dir>`. */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./zmux.ts"

const out = resolve(process.argv[2] ?? join(tmpdir(), "tui-shots"))
mkdirSync(out, { recursive: true })
const app = resolve(import.meta.dir, "..")
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const shoot = (tui: Tui, name: string) => {
  const html = join(out, `${name}.html`)
  writeFileSync(html, tui.html())
  spawnSync(chrome, [
    "--headless=new",
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "chrome-"))}`,
    `--screenshot=${join(out, `${name}.png`)}`,
    `--window-size=${tui.cols * 8 + 40},${tui.rows * 17 + 24}`,
    `file://${html}`
  ], { timeout: 120_000 })
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
for (const cols of [120, 84]) {
  const tui = await Tui.start({
    cwd: mkdtempSync(join(tmpdir(), "tui-shots-repo-")),
    command: `bun ${join(app, "e2e", "tabs-fixture.tsx")}`,
    cols,
    rows: 34,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-shots-")) }
  })
  try {
    await tui.until((screen) => screen.includes("Ask Smithers"), 20_000, "first draw")
    await tui.type("delegate")
    await tui.press(key.enter)
    await sleep(1500)
    await tui.type("more")
    await tui.press(key.enter)
    await sleep(1500)
    shoot(tui, `${cols}-chat`)
    await tui.press("\x1b[1;5C") // ctrl+right: Summary
    await sleep(300)
    await tui.press("\x1b[1;5C") // first worker
    await sleep(800)
    shoot(tui, `${cols}-worker-running`)
    await tui.type("s")
    await sleep(300)
    await tui.type("also check the refresh path")
    await tui.press(key.enter)
    await sleep(500)
    shoot(tui, `${cols}-worker-steer`)
    await tui.press(key.escape)
    await sleep(200)
    for (let step = 0; step < 2; step++) {
      await tui.press("\x1b[1;5C")
      await sleep(300)
    }
    await sleep(500)
    shoot(tui, `${cols}-worker-failed`)
    await tui.press("\x1b[1;5C")
    await sleep(800)
    shoot(tui, `${cols}-worker-overflow`)
  } finally {
    await tui.stop()
  }
}
console.log(out)
