import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { localApiGet, localApiPost } from "./localApi"

/*
 * Lane L3 (docs/LOCAL-APP.md "Target presentation"): opening a repository
 * through the chrome renders nothing; /target.list loads its Smithers targets
 * into a trusted typed card, and that card's parent-owned Run button streams a
 * target run into a target-run card.
 * A throwaway copy of the checked-in force-spec workspace proves the loader
 * and table at scale (>= 80 targets), without depending on a personal checkout.
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; the real endpoint is the manual proof")
test.setTimeout(180_000)

// Playwright loads specs as CommonJS, so the fixture resolves from __dirname.
const FIXTURE = resolve(__dirname, "../../../../packages/smithers/build/build-cli/test/fixtures/force-spec")

const targetsCard = (page: Page) => page.locator(".smithers-card[data-kind=\"targets\"]")
const repoCard = (page: Page) => page.locator(".smithers-card[data-kind=\"repo\"]")
const runCard = (page: Page) => page.locator(".smithers-card[data-kind=\"target-run\"]")
const opened: Array<string> = []
const temporary: Array<string> = []

/** The chrome's Open repository, answered through the window.prompt fallback. */
const openRepo = async (page: Page, path: string): Promise<void> => {
  page.once("dialog", (dialog) => void dialog.accept(path))
  await page.getByTestId("composer-repo-trigger").click()
  await page.getByTestId("chrome-open-repo").click()
  await expect(page.getByTestId("repo-chip")).toHaveAttribute("title", realpathSync(path), { timeout: 30_000 })
}

/** Type a registered slash command into the composer and send it. */
const command = async (page: Page, text: string): Promise<void> => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-send").click()
}

/** Opening renders nothing in the transcript: no repo card, no targets card, no message. */
const expectNothingAutomatic = async (page: Page): Promise<void> => {
  await expect(repoCard(page)).toHaveCount(0)
  await expect(targetsCard(page)).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  // Cards persist per browser profile; every test starts from an empty transcript.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test.afterEach(async ({ page, request }) => {
  try {
    if (opened.length > 0) {
      const listed = await localApiGet(page, request, "/api/repos")
      if (listed.ok()) {
        const { repos } = (await listed.json()) as { repos: Array<{ id: string; path: string }> }
        for (const repo of repos) {
          if (opened.includes(repo.path)) await localApiPost(page, request, "/api/repo/close", { repoId: repo.id })
        }
      }
    }
  } finally {
    opened.length = 0
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
  }
})

test("opening a real fixture repository loads its trusted target card", async ({ page }) => {
  const copy = mkdtempSync(join(tmpdir(), "smithers-target-table-"))
  temporary.push(copy)
  cpSync(FIXTURE, copy, { recursive: true })
  const copyPath = realpathSync(copy)
  await page.goto("/")
  await openRepo(page, copyPath)
  opened.push(copyPath)
  // The selector names the repo; the origin chip shows WHERE it is (the ~-abbreviated path), never the name again.
  await expect(page.getByTestId("composer-repo-trigger")).toHaveText(basename(copyPath))
  await expect(page.getByTestId("repo-chip")).toHaveAttribute("title", copyPath)
  await expectNothingAutomatic(page)

  // The targets table is the explicit act.
  const querying = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/targets/query")
  await command(page, "/target.list")
  const query = await querying
  expect(query.status()).toBe(200)
  const total = ((await query.json()) as { targets: unknown[] }).targets.length
  expect(total).toBeGreaterThanOrEqual(80)
  const targets = targetsCard(page)
  await expect(targets).toBeVisible()
  await expect(targets.getByTestId("card-kind-targets")).toBeVisible()
  // The loader answers in a few seconds on force; the row count is the whole workspace.
  // Rows are fewer than targets: names shared across packages read as one grouped row; the count is in targets.
  await expect(targets.getByTestId("targets-count")).toHaveText(`${total} of ${total}`, { timeout: 60_000 })
  expect(await targets.locator("[data-target-row]").count()).toBeGreaterThanOrEqual(1)
  await expect(targets.locator("[data-target-row=\"//:detectSecrets\"]")).toBeVisible()

  // The table scrolls inside the card, never the transcript: a bounded, overflow-auto container.
  const scroll = targets.getByTestId("targets-scroll")
  const overflow = await scroll.evaluate((node) => {
    const style = getComputedStyle(node)
    return { overflowY: style.overflowY, bounded: node.scrollHeight > node.clientHeight }
  })
  expect(overflow.overflowY).toBe("auto")
  expect(overflow.bounded).toBe(true)
  await expect(targets.getByTestId("targets-count")).toHaveText(`${total} of ${total}`)

  // Filtering narrows the rows and the count; clearing restores them.
  await targets.getByTestId("targets-filter-query").fill("detectSecrets")
  await expect(targets.getByTestId("targets-count")).toHaveText(new RegExp(`^[1-9] of ${total}$`))
  const narrowed = await targets.locator("[data-target-row]").count()
  expect(narrowed).toBeGreaterThanOrEqual(1)
  expect(narrowed).toBeLessThan(10)
  await expect(targets.locator("[data-target-row=\"//:detectSecrets\"]")).toBeVisible()
  await targets.getByTestId("targets-filter-query").fill("")
  await expect(targets.getByTestId("targets-count")).toHaveText(`${total} of ${total}`)

  // A kind chip is a filter too, and reads as pressed while it is on.
  const chip = targets.locator('[data-testid^="targets-chip-kind-"]').first()
  const kind = (await chip.textContent()) ?? ""
  await chip.click()
  await expect(chip).toHaveAttribute("aria-pressed", "true")
  const kept = await targets.locator("[data-target-row]").count()
  expect(kept).toBeGreaterThan(0)
  expect(kept).toBeLessThan(total)
  await expect(targets.locator("[data-target-row]").first().locator("[data-slot=badge]").filter({ hasText: kind }).first()).toBeVisible()
  await chip.click()
  await expect(chip).toHaveAttribute("aria-pressed", "false")

  // Selecting a row opens its drawer beside the table, with the facts the server read for it.
  await targets.getByTestId("targets-select-//:detectSecrets").click()
  const drawer = targets.getByTestId("targets-drawer-//:detectSecrets")
  await expect(drawer).toBeVisible()
  await expect(drawer).toContainText("Runs")
  await expect(drawer).toContainText("rule")
  // The plan read lands within the graph budget; the drawer then names deps and the cache stance.
  await expect(drawer).toContainText(/deps/, { timeout: 60_000 })
  await expect(drawer).toContainText(/cache/)
  await drawer.getByRole("button", { name: "Close details" }).click()
  await expect(drawer).toHaveCount(0)

  // No manifest and no stars: the card opens on All. A star moves the row into Featured, which then leads.
  await expect(targets.getByTestId("targets-mode-all")).toHaveAttribute("aria-pressed", "true")
  await targets.getByTestId("targets-star-//:detectSecrets").click()
  await expect(targets.getByTestId("targets-star-//:detectSecrets")).toHaveAttribute("aria-pressed", "true")
  await targets.getByTestId("targets-mode-featured").click()
  await expect(targets.getByTestId("targets-mode-featured")).toHaveAttribute("aria-pressed", "true")
  await expect(targets.getByTestId("targets-count")).toHaveText(`1 of ${total}`)
  await expect(targets.locator("[data-target-row=\"//:detectSecrets\"]")).toBeVisible()
  await targets.getByTestId("targets-star-//:detectSecrets").click()
  await expect(targets.getByTestId("targets-count")).toHaveText(`0 of ${total}`)
  await targets.getByTestId("targets-mode-all").click()
  await expect(targets.getByTestId("targets-count")).toHaveText(`${total} of ${total}`)
})

test("a trusted Run button streams a target run to completion", async ({ page, request }) => {
  const copy = mkdtempSync(join(tmpdir(), "smithers-force-spec-"))
  temporary.push(copy)
  cpSync(FIXTURE, copy, { recursive: true })

  await page.goto("/")
  await openRepo(page, copy)
  const copyPath = realpathSync(copy)
  opened.push(copyPath)
  await command(page, "/target.list")
  await expect(targetsCard(page).getByTestId("targets-count")).toHaveText(/^8[12] of 8[12]$/, { timeout: 60_000 })
  // //.github:dangerCi renders a workflow file and exits 0 with no network.
  const danger = targetsCard(page).locator('[data-target-row="//.github:dangerCi"]')
  await expect(danger).toBeVisible()
  await danger.getByRole("button", { name: "Run //.github:dangerCi" }).click()

  const run = runCard(page)
  await expect(run).toBeVisible()
  await expect(run).toContainText("//.github:dangerCi")
  await expect.poll(() => run.locator("[data-run-status]").getAttribute("data-run-status"), { timeout: 90_000 })
    .toMatch(/^(done|failed)$/)
  const output = run.locator("[data-testid^=\"target-run-output-\"]")
  await expect(output).not.toHaveText("")
  await expect(output).toContainText("dangerCi")
  await expect(run.locator("[data-run-status]")).toHaveAttribute("data-run-status", "done")
  await expect(run).toContainText("exit 0")

  // The table's last-run column follows the recording: the row now reads passed and offers its timeline.
  await expect(danger).toHaveAttribute("data-state", "passed", { timeout: 30_000 })
  await expect(danger.getByRole("button", { name: /Timeline of the last run/ })).toBeVisible()

  // Recent lists what ran, so the one run leads it alone.
  await targetsCard(page).getByTestId("targets-mode-recent").click()
  await expect(targetsCard(page).locator("[data-target-row]").first()).toHaveAttribute("data-target-row", "//.github:dangerCi")
  await expect(targetsCard(page).getByTestId("targets-count")).toHaveText(/^1 of 8[12]$/)

  // The maximized targets card offers Open in tab; the tab renders the same trusted card.
  const targetsId = (await targetsCard(page).getAttribute("data-testid"))?.replace(/^card-/, "") ?? ""
  expect(targetsId).toMatch(/^targets-/)
  await targetsCard(page).getByTestId(`card-maximize-${targetsId}`).click()
  await expect(targetsCard(page)).toHaveAttribute("data-maximized", "true")
  await page.getByTestId(`card-open-in-tab-${targetsId}`).click()
  // openCardTab coins the tab id as `card-${cardId}` (state/controller/tabs.ts), and the
  // chrome renders `tab-${tab.id}` / `tab-body-${tab.id}` over it. Compose the id the same
  // way so the literal pin checks each half against the prefixes the app really builds.
  const cardTabId = `card-${targetsId}`
  const tab = page.getByTestId(`tab-${cardTabId}`)
  await expect(tab).toHaveAttribute("data-active", "true")
  const tabBody = page.getByTestId(`tab-body-${cardTabId}`)
  await expect(tabBody).toBeVisible()
  await expect(tabBody.locator('[data-target-row="//.github:dangerCi"]')).toBeVisible()
  await page.getByTestId("workspace-name").click()

  const listed = await localApiGet(page, request, "/api/repos")
  expect(listed.status()).toBe(200)
  const { repos } = (await listed.json()) as { repos: Array<{ path: string; smithers: { detected: boolean } }> }
  expect(repos.find((repo) => repo.path === copyPath)?.smithers.detected).toBe(true)
})

test("a directory without Smithers files opens silently, and /target.list says why there are none", async ({ page }) => {
  const plain = mkdtempSync(join(tmpdir(), "smithers-plain-"))
  temporary.push(plain)
  await page.goto("/")
  await openRepo(page, plain)
  opened.push(realpathSync(plain))
  await expect(page.getByTestId("repo-chip")).toBeVisible()
  await expectNothingAutomatic(page)
  await command(page, "/target.list")
  await expect(page.locator("body")).toContainText("no WORKSPACE.ts")
  await expect(targetsCard(page)).toHaveCount(0)
})

/*
 * A pattern run (`lint //.github/...`): a verb over a pattern, the "run
 * everything" form. The Featured view's strip offers the whole-workspace
 * sweeps; a narrower pattern is the `/target.run.pattern` command. The card
 * renders one row per target the CLI resolved with failures first, the
 * totals, and the raw stream folded away. The copy is git-initialised
 * because the lint verb diffs against HEAD, and the generated GitHub files
 * are absent from the fixture, so `//.github:github` fails on drift — a
 * real failure the row expands to.
 */
test("a pattern run renders one row per resolved target, failures first, with the totals", async ({ page, request }) => {
  const copy = mkdtempSync(join(tmpdir(), "smithers-force-pattern-"))
  temporary.push(copy)
  cpSync(FIXTURE, copy, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: copy })
  execFileSync("git", ["add", "-A"], { cwd: copy })
  execFileSync("git", ["-c", "user.email=e2e@smithers.sh", "-c", "user.name=e2e", "commit", "-qm", "fixture"], { cwd: copy })

  await page.goto("/")
  await openRepo(page, copy)
  opened.push(realpathSync(copy))
  await command(page, "/target.list")
  const targets = targetsCard(page)
  await expect(targets.getByTestId("targets-count")).toHaveText(/of 8[12]$/, { timeout: 60_000 })
  // Nothing is featured or starred, so All is the default; the strip is the Featured view's.
  await expect(targets.getByTestId("targets-mode-all")).toHaveAttribute("aria-pressed", "true")
  await targets.getByTestId("targets-mode-featured").click()
  const strip = targets.getByTestId("targets-pattern-runs")
  await expect(strip).toContainText("ci //...")
  await expect(strip).toContainText("lint //...")
  const listed = await localApiGet(page, request, "/api/repos")
  const { repos } = (await listed.json()) as { repos: Array<{ id: string; path: string }> }
  const repoId = repos.find((repo) => repo.path === realpathSync(copy))?.id
  expect(repoId).toBeDefined()
  await command(page, `/target.run.pattern ${repoId} lint //.github/...`)

  const run = runCard(page)
  await expect(run).toBeVisible()
  await expect(run).toContainText("lint //.github/...")
  await expect.poll(() => run.locator("[data-run-status]").getAttribute("data-run-status"), { timeout: 90_000 })
    .toMatch(/^(done|failed)$/)
  await expect.poll(() => run.locator("[data-run-row]").count()).toBeGreaterThanOrEqual(2)
  const kpis = run.locator("[data-testid^=\"target-run-kpis-\"]")
  await expect(kpis.locator("[data-kpi=\"ran\"]")).toContainText("3")
  await expect(kpis.locator("[data-kpi=\"failed\"]")).toContainText("1")
  // Failures lead once the run settled; the failed row expands to its own reason.
  await expect(run.locator("[data-run-row]").first()).toHaveAttribute("data-run-row", "//.github:github")
  await expect(run.locator("[data-run-row=\"//.github:github\"]")).toHaveAttribute("data-node-status", "failed")
  await run.locator("[data-run-row=\"//.github:github\"] summary").click()
  await expect(run.locator("[data-run-row=\"//.github:github\"] .target-run-failure-output")).toContainText("drift")
  // The raw stream is folded away, not gone.
  const raw = run.locator("[data-testid^=\"target-run-raw-\"]")
  await expect(raw).toHaveJSProperty("open", false)
  await raw.locator("summary").click()
  await expect(raw.locator("pre")).toContainText("4 targets")
})
