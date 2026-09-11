import { expect, test } from "@playwright/test"
import type { Locator, Page } from "@playwright/test"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { resolve } from "node:path"

/*
 * The target-graph cards end to end (docs/LOCAL-APP.md "Cards: target
 * graph"), tier T1: the local origin in headless Chromium — no electrobun
 * shell, so this runs anywhere `pnpm -C apps/app test:e2e` runs.
 *
 * The backend lane's routes land in parallel, so this spec drives the cards
 * from the dev fixture seam (dev/fixtureRunStream.ts) behind its explicit
 * localStorage flag, which is never on in the product path. Each card is
 * screenshotted into docs/screenshots/.
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; the real endpoint is the manual proof")

/* The committed force spec: a repository that declares targets, on every machine. */
const FIXTURE_REPO = resolve(__dirname, "../../../../packages/smithers/build/build-cli/test/fixtures/force-spec")
const SHOTS = resolve(__dirname, "../../docs/screenshots")

const FIXTURE_FLAG = "smithers.dev.targetGraphFixtures"

const card = (page: Page, kind: string): Locator => page.locator(`.smithers-card[data-kind="${kind}"]`)

const shoot = async (target: Locator, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true })
  await target.screenshot({ path: resolve(SHOTS, `${name}.png`) })
}

/** Type a registered slash command into the composer and send it. */
const command = async (page: Page, text: string): Promise<void> => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-send").click()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((flag) => {
    try {
      window.localStorage.clear()
      /* The explicit dev opt-in: the fixtures stand in for the backend routes. */
      window.localStorage.setItem(flag as string, "1")
    } catch {
      // Storage the browser refuses is the flag off, and the spec skips below.
    }
  }, FIXTURE_FLAG)
})

test("every target-graph card renders against the fixture stream", async ({ page }) => {
  test.skip(!existsSync(FIXTURE_REPO), `${FIXTURE_REPO} is not on this machine`)
  await page.goto("/")

  /* A repository has to be open: the commands resolve the single open repo. */
  page.once("dialog", (dialog) => void dialog.accept(FIXTURE_REPO))
  await page.getByTestId("composer-repo-trigger").click()
  await page.getByTestId("chrome-open-repo").click()
  await expect(page.getByTestId("repo-chip")).toHaveAttribute("title", realpathSync(FIXTURE_REPO), { timeout: 30_000 })
  await expect(card(page, "repo")).toHaveCount(0)

  // 1. The graph card: the typed DAG, laid out, with its counts line.
  await command(page, "/target.graph")
  const graph = card(page, "graph")
  await expect(graph).toBeVisible({ timeout: 30_000 })
  await expect(graph.locator(".graph-card-counts")).toContainText("targets")
  await expect(graph.locator("[data-label]").first()).toBeVisible()
  /*
   * The DAG has to be PAINTED, not merely mounted: React Flow's panes ask for
   * `height: 100%`, and against an indefinite canvas height that resolves to
   * zero — 82 nodes in the DOM, an empty card on screen. Assert the pane has
   * real height and that a node's box actually lands inside the canvas.
   */
  const pane = graph.locator(".react-flow")
  const paneBox = await pane.boundingBox()
  const canvasBox = await graph.locator(".graph-card-canvas").boundingBox()
  expect(paneBox?.height ?? 0).toBeGreaterThan(200)
  expect(canvasBox?.height ?? 0).toBeGreaterThan(200)
  /*
   * 82 nodes are wider than the card at React Flow's minZoom, so the fitted
   * view legitimately overflows — the human pans. What must hold is that
   * nodes land ON the canvas at all: with the zero-height pane, none did.
   */
  const painted = await graph.locator(".react-flow__node").evaluateAll((nodes, canvas) => {
    const box = canvas as { x: number; y: number; width: number; height: number }
    return nodes.filter((node) => {
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 &&
        rect.right > box.x && rect.x < box.x + box.width &&
        rect.bottom > box.y && rect.y < box.y + box.height
    }).length
  }, canvasBox)
  expect(painted).toBeGreaterThan(0)
  await shoot(graph, "graph-card")

  /*
   * The detail drawer, through the focus command rather than a canvas click:
   * with 82 nodes fitted into the card, a given node's centre can sit under
   * the pane's own hit area, and the drawer is what this screenshot is for.
   */
  await command(page, "/target.graph //src:typeCheck")
  await expect(graph.locator("[data-testid=\"graph-drawer-//src:typeCheck\"]")).toBeVisible({ timeout: 30_000 })
  await expect(graph.locator(".graph-drawer-fact-name").first()).toBeVisible()
  await shoot(graph, "graph-card-drawer")

  // 2. The run history card, and 3. the replay timeline a row selects.
  await command(page, "/target.history")
  const history = card(page, "run-history")
  await expect(history).toBeVisible({ timeout: 30_000 })
  await expect(history.locator("[data-run-row]").first()).toBeVisible()
  await shoot(history, "run-history-card")

  await history.locator("[data-run-row] .run-history-select").first().click()
  const timeline = card(page, "run-timeline")
  await expect(timeline).toBeVisible({ timeout: 30_000 })
  await expect(timeline.locator("[data-timeline-row]").first()).toBeVisible()
  await shoot(timeline, "run-timeline-card")

  // The scrubber is the time-travel affordance; it moves both cards.
  const scrubber = timeline.locator("[data-testid^=\"run-timeline-scrubber-\"]")
  await expect(scrubber).toBeVisible()

  // 4. Affected, and 5. the CI matrix.
  await command(page, "/target.affected")
  const affected = card(page, "affected")
  await expect(affected).toBeVisible({ timeout: 30_000 })
  await shoot(affected, "affected-card")

  await command(page, "/target.ci")
  const ci = card(page, "ci-matrix")
  await expect(ci).toBeVisible({ timeout: 30_000 })
  await shoot(ci, "ci-matrix-card")
})
