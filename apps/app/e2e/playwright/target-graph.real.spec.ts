import { expect, test } from "@playwright/test"
import type { Locator, Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { localApiGet, localApiPost } from "./localApi"

/*
 * The target-graph feature end to end against the REAL backend — no fixture
 * seam, no stubbed routes. `target-graph.spec.ts` proves the cards render
 * from the captured fixtures; this spec proves the product actually works:
 * every card here is filled by the Bun backend spawning the real `smithers-build`
 * loader against a real workspace on this machine.
 *
 * The whole flow, in one session, in the order a human does it:
 *   open the repo → list targets → show graph → focus a node → run //:hello →
 *   watch the overlay and the timeline settle → open history → replay with
 *   the scrubber → touch a file and show affected → show ci.
 *
 * Tier T1: the local origin in headless Chromium. The Electrobun shell is
 * NOT exercised — see e2e/packaged for that tier; what this spec
 * cannot cover is the native window chrome and the OS folder picker, which
 * is why the repository is opened through the window.prompt fallback.
 *
 * The backend loads a unique temporary copy of the checked-in repo-plugin
 * workspace. Its hello target needs no network or installed dependencies;
 * tracked scratch and CI files exercise the real git and YAML readers.
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; the real endpoint is the manual proof")

const FIXTURE = resolve(__dirname, "../fixtures/repo-plugin")
let ownedRoot: string | undefined
let openedRepoPath: string | undefined

/* Leave time for a cold real loader while keeping the workspace small. */
const SLOW = 180_000
test.setTimeout(600_000)

const card = (page: Page, kind: string): Locator => page.locator(`.smithers-card[data-kind="${kind}"]`)

/** Type a registered slash command into the composer and send it. */
const command = async (page: Page, text: string): Promise<void> => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-send").click()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
      /*
       * The fixture flag must be OFF. If it leaked on, every assertion below
       * would pass against captured JSON and prove nothing about the backend.
       */
      window.localStorage.removeItem("smithers.dev.targetGraphFixtures")
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test.afterEach(async ({ page, request }, testInfo) => {
  try {
    if (openedRepoPath !== undefined) {
      // The real executor's journal explains failures before the owned repo is
      // removed. Browser traces retain the UI, but not its WebSocket frames.
      const runsDir = join(openedRepoPath, ".flows", "ui", "runs")
      if (testInfo.status !== testInfo.expectedStatus && existsSync(runsDir)) {
        for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            await testInfo.attach(`target-run-${entry.name}`, {
              path: join(runsDir, entry.name),
              contentType: "application/x-ndjson"
            })
          }
        }
      }
      const listed = await localApiGet(page, request, "/api/repos")
      if (listed.ok()) {
        const { repos } = (await listed.json()) as { repos: Array<{ id: string; path: string }> }
        const opened = repos.find((repo) => repo.path === openedRepoPath)
        if (opened !== undefined) await localApiPost(page, request, "/api/repo/close", { repoId: opened.id })
      }
    }
  } finally {
    openedRepoPath = undefined
    if (ownedRoot !== undefined) rmSync(ownedRoot, { recursive: true, force: true })
    ownedRoot = undefined
  }
})

test("the whole target-graph flow against the real backend", async ({ page }) => {
  ownedRoot = realpathSync(mkdtempSync(join(tmpdir(), "smithers-target-graph-e2e-")))
  const repository = join(ownedRoot, "repo-plugin-fixture")
  cpSync(FIXTURE, repository, {
    recursive: true,
    filter: (path) => ![".git", ".flows", "node_modules"].includes(basename(path))
  })
  const runsDir = join(repository, ".flows", "ui", "runs")
  const scratch = join(repository, "smithers-e2e-affected.ts")
  writeFileSync(scratch, "export const smithersE2eAffected = false\n")
  writeFileSync(join(repository, ".gitignore"), ".flows/\n")
  mkdirSync(join(repository, ".github", "workflows"), { recursive: true })
  writeFileSync(join(repository, ".github", "workflows", "fixture.yml"), [
    "name: fixture-ci", "on: [push]", "jobs:", "  hello:", "    runs-on: ubuntu-latest",
    "    steps:", "      - run: smithers-build //:hello", ""
  ].join("\n"))
  execFileSync("git", ["init", "-q"], { cwd: repository })
  execFileSync("git", ["add", "-A"], { cwd: repository })
  execFileSync("git", ["-c", "user.email=e2e@smithers.sh", "-c", "user.name=e2e", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"], { cwd: repository })

  await page.goto("/")
  openedRepoPath = repository
  page.once("dialog", (dialog) => void dialog.accept(repository))
  await page.getByTestId("composer-repo-trigger").click()
  await page.getByTestId("chrome-open-repo").click()
  await expect(page.getByTestId("composer-repo-trigger")).toHaveText("repo-plugin-fixture", { timeout: SLOW })
  await expect(page.getByTestId("repo-chip")).toHaveAttribute("title", repository)
  // Opening selects the working copy silently. Target discovery is its own act.
  await expect(card(page, "repo")).toHaveCount(0)
  await expect(card(page, "targets")).toHaveCount(0)
  await command(page, "/target.list")
  const targets = card(page, "targets")
  await expect(targets).toBeVisible({ timeout: SLOW })
  await expect(targets.locator('[data-target-row="//:hello"]')).toBeVisible({ timeout: SLOW })

  // 1. The typed DAG, loaded by the real loader from the real declarations.
  await command(page, "/target.graph")
  const graph = card(page, "graph")
  await expect(graph).toBeVisible({ timeout: SLOW })
  await expect(graph.locator(".graph-card-counts")).toContainText("targets", { timeout: SLOW })
  /* A real workspace, not a fixture: the loader finds the whole graph. */
  const counts = await graph.locator(".graph-card-counts").textContent()
  const targetCount = Number(/(\d+) targets/.exec(counts ?? "")?.[1] ?? "0")
  expect(targetCount).toBeGreaterThanOrEqual(1)
  /* The DAG is PAINTED, not merely mounted. */
  const canvasBox = await graph.locator(".graph-card-canvas").boundingBox()
  expect(canvasBox?.height ?? 0).toBeGreaterThan(200)
  const painted = await graph.locator(".react-flow__node").evaluateAll((nodes, box) =>
    nodes.filter((node) => {
      const rect = node.getBoundingClientRect()
      const canvas = box as { x: number; y: number; width: number; height: number }
      return rect.width > 0 && rect.height > 0 &&
        rect.right > canvas.x && rect.x < canvas.x + canvas.width &&
        rect.bottom > canvas.y && rect.y < canvas.y + canvas.height
    }).length, canvasBox)
  expect(painted).toBeGreaterThan(0)

  // 2. Focus a node: the drawer shows the plan facts the planner really returned.
  await command(page, "/target.graph //:hello")
  const drawer = graph.locator("[data-testid=\"graph-drawer-//:hello\"]")
  await expect(drawer).toBeVisible({ timeout: SLOW })
  await expect(drawer.locator(".graph-drawer-label")).toHaveText("//:hello")
  /* A rule the loader named, not a placeholder. */
  await expect(drawer.locator(".graph-drawer-fact-name").first()).toBeVisible()
  const drawerText = await drawer.textContent()
  expect(drawerText).toContain("Shell.Test")

  // 3. Run the target for real, from the drawer's own Run button — the
  //    affordance a human actually clicks, which carries the repository id
  //    that a typed /target.run has no way to name.
  await drawer.locator("[data-flow=\"target.run\"]").click()
  const runCard = card(page, "target-run")
  await expect(runCard).toBeVisible({ timeout: SLOW })
  /* The graph card picks the run up and shows its status legend. */
  await expect(graph.locator(".graph-card-legend")).toBeVisible({ timeout: SLOW })
  /*
   * The overlay has to carry REAL statuses. A node painted with a run status
   * is a node the backend reported, so waiting for one is waiting for the
   * stream, not for a timer.
   */
  await expect
    .poll(async () => graph.locator(".graph-node[data-run-status]").count(), { timeout: SLOW })
    .toBeGreaterThan(0)

  /*
   * Let the run FINISH before replaying it. A human replays a finished run,
   * and a card opened mid-flight is fed from two sources at once: the replay
   * fold at its cursor, and the live fold repainting the same card as the
   * remaining frames land. Waiting here keeps the scrubber assertions below
   * about time travel rather than about that race.
   */
  await expect
    .poll(async () => runCard.locator(".target-run-card").getAttribute("data-run-status"), { timeout: SLOW })
    .toMatch(/^(done|failed)$/)

  // 4. History: the run it just executed is recorded, on disk, in this repo.
  await expect.poll(() => existsSync(runsDir), { timeout: SLOW }).toBe(true)
  await command(page, "/target.history")
  const history = card(page, "run-history")
  await expect(history).toBeVisible({ timeout: SLOW })
  const rows = history.locator("[data-run-row]")
  await expect.poll(() => rows.count(), { timeout: SLOW }).toBeGreaterThan(0)
  await expect(rows.first()).toContainText("//:hello")

  // 5. Replay: selecting the row rebuilds the timeline from the recording.
  await history.locator("[data-run-row] .run-history-select").first().click()
  const timeline = card(page, "run-timeline")
  await expect(timeline).toBeVisible({ timeout: SLOW })
  const timelineRows = timeline.locator("[data-timeline-row]")
  await expect.poll(() => timelineRows.count(), { timeout: SLOW }).toBeGreaterThan(0)
  /* The rows are the labels the run really touched. */
  await expect(timeline.locator("[data-timeline-row=\"//:hello\"]")).toBeVisible()

  // 6. The scrubber is time travel: dragging to the start empties the Gantt.
  const scrubber = timeline.locator("[data-testid^=\"run-timeline-scrubber-\"]")
  await expect(scrubber).toBeVisible()
  const settledRows = await timelineRows.count()
  const min = await scrubber.getAttribute("min")
  const max = await scrubber.getAttribute("max")
  /*
   * The scrubber is a CONTROLLED React range. Playwright's `fill` writes the
   * DOM value directly, which leaves React's internal value tracker stale, so
   * the second drag of a session can be swallowed as "no change". Go through
   * the prototype setter React itself patches, then dispatch the `input` the
   * card listens on — the standard way to drive a controlled input.
   */
  const drag = async (value: string): Promise<void> => {
    await scrubber.evaluate((element, next) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
      setter?.call(element, next)
      element.dispatchEvent(new Event("input", { bubbles: true }))
    }, value)
  }

  await drag(String(min))
  /*
   * At the first instant of the run, fewer nodes had reported than at the
   * end. A scrubber that changed nothing would be a slider over a still.
   */
  await expect.poll(() => timelineRows.count(), { timeout: 30_000 }).toBeLessThan(settledRows)
  /* And travelling back to the end restores every row the run produced. */
  await drag(String(max))
  await expect.poll(() => timelineRows.count(), { timeout: 30_000 }).toBe(settledRows)

  // 7. Affected: a real edit to a real file, read through the real git diff.
  writeFileSync(scratch, "export const smithersE2eAffected = true\n")
  await command(page, "/target.affected")
  const affected = card(page, "affected")
  await expect(affected).toBeVisible({ timeout: SLOW })
  /* The file just written is what the working-tree diff reports. */
  await expect(affected).toContainText("smithers-e2e-affected.ts", { timeout: SLOW })

  // 8. The CI matrix the graph implies, read from the workspace's workflows.
  await command(page, "/target.ci")
  const ci = card(page, "ci-matrix")
  await expect(ci).toBeVisible({ timeout: SLOW })
  await expect(ci.locator(".ci-matrix-jobs").first()).toBeVisible({ timeout: SLOW })
  await expect(ci.locator("[data-job-row]").first()).toBeVisible({ timeout: SLOW })
  await expect(ci).toContainText("fixture-ci")
  await expect(ci).toContainText("//:hello")
})
