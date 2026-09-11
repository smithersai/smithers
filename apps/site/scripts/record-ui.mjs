/**
 * Records the product UI (apps/app, served by its own local origin with the
 * target-graph fixture seam on) once per color scheme, and turns each
 * recording into public/media/ui-<scheme>.gif and .webm.
 *
 * Prerequisites: `pnpm --filter smithers-app run build:web`, then a running
 * `SMITHERS_SKIP_SPA_BUILD=1 SMITHERS_LOCAL_PORT=47399 SMITHERS_CHAT_STUB=1
 * bun e2e/playwright/webserver.ts` from apps/app. Playwright's Chromium comes
 * from apps/app's own dependency. ffmpeg must be on PATH.
 *
 * Usage: node scripts/record-ui.mjs [dark|light]   (default: both)
 */
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const here = fileURLToPath(new URL(".", import.meta.url))
const root = resolve(here, "../../..")
const uiRequire = createRequire(resolve(root, "apps/app/package.json"))
const { chromium } = uiRequire("@playwright/test")

const BASE = process.env.SMITHERS_UI_ORIGIN ?? "http://127.0.0.1:47399"
const FIXTURE_REPO = resolve(root, "packages/smithers/build/build-cli/test/fixtures/force-spec")
const FIXTURE_FLAG = "smithers.dev.targetGraphFixtures"
const OUT = resolve(here, "../public/media")
const SIZE = { width: 1280, height: 800 }

const schemes = process.argv[2] ? [process.argv[2]] : ["dark", "light"]
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

const type = async (page, text) => {
  const input = page.getByTestId("composer-input")
  await input.click()
  await input.pressSequentially(text, { delay: 45 })
  await pause(350)
  await page.getByTestId("composer-send").click()
}

const record = async (scheme) => {
  const videoDir = resolve(OUT, `.video-${scheme}`)
  rmSync(videoDir, { recursive: true, force: true })
  const browser = await chromium.launch()
  const context = await browser.newContext({
    colorScheme: scheme,
    viewport: SIZE,
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: SIZE }
  })
  const page = await context.newPage()
  await page.addInitScript((flag) => {
    try {
      window.localStorage.clear()
      window.localStorage.setItem(flag, "1")
    } catch {}
  }, FIXTURE_FLAG)
  await page.goto(BASE + "/")
  await page.getByTestId("composer-input").waitFor({ state: "visible", timeout: 60_000 })
  await pause(1200)

  page.once("dialog", (dialog) => void dialog.accept(FIXTURE_REPO))
  await page.getByTestId("composer-repo-trigger").click()
  await pause(400)
  const opened = page.waitForResponse((response) => response.url().includes("/api/repo/open"), { timeout: 60_000 })
  await page.getByTestId("chrome-open-repo").click()
  await opened
  await pause(1500)

  await type(page, "/target.graph")
  await page.locator('.smithers-card[data-kind="graph"]').waitFor({ state: "visible", timeout: 30_000 })
  await pause(2500)

  await type(page, "/target.affected")
  await page.locator('.smithers-card[data-kind="affected"]').waitFor({ state: "visible", timeout: 30_000 })
  await pause(2200)

  await type(page, "/target.ci")
  await page.locator('.smithers-card[data-kind="ci-matrix"]').waitFor({ state: "visible", timeout: 30_000 })
  await pause(2200)

  await type(page, "/target.history")
  await page.locator('.smithers-card[data-kind="run-history"]').waitFor({ state: "visible", timeout: 30_000 })
  await pause(2600)

  await context.close()
  await browser.close()

  const [file] = readdirSync(videoDir).filter((f) => f.endsWith(".webm"))
  if (!file) throw new Error(`no video recorded for ${scheme}`)
  mkdirSync(OUT, { recursive: true })
  const webm = resolve(OUT, `ui-${scheme}.webm`)
  renameSync(resolve(videoDir, file), webm)
  rmSync(videoDir, { recursive: true, force: true })
  const gif = resolve(OUT, `ui-${scheme}.gif`)
  const filters = "fps=12,scale=1024:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4"
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-vf", filters, gif], { stdio: "inherit" })
  console.log(`wrote ${gif}`)
}

for (const scheme of schemes) await record(scheme)
