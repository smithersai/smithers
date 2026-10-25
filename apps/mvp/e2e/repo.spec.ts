import { expect, recordActions, test, visibleText } from "./fixtures"
import { requires } from "./target"

// Clone a public GitHub repository and browse it (docs/features/repo.md, decision 0006), against the real app,
// Worker, Durable Object, Postgres, Electric, GitHub and Code Storage. The fixture is the tiny public
// `octocat/Spoon-Knife` (README.md, index.html, styles.css); nothing is created on GitHub. Cloning it is idempotent, so
// a second run finds it ready and browses it. Locally the run needs the Code Storage organization in the dev server's
// environment; a deployment holds it. Every test asks for a clone, a Member's request (worker/RepoApi.ts `canClone`),
// and waits on the `repo/clone` remote flow (worker/RepoApi.ts `start`, worker/flows/RepoClone.ts), which decides
// both ready and the clone refusal. About establishes Not found before a clone is requested.

requires("codeStorage", "member")

const REPO = "/octocat/Spoon-Knife"

/** Clones the fixture if it isn't there yet, and waits until the repository opens on its README. */
const openReady = async (page: import("@playwright/test").Page) => {
  await page.goto(REPO)
  // The repository's header: the screen's main landmark carries the same label.
  const header = page.locator('header[aria-label="Repository"]')
  // The app's first render on a loaded machine can take seconds: the engine worker and the device store start first.
  await expect(header).toContainText("octocat / Spoon-Knife", { timeout: 30_000 })
  // GitHub's preview shows the README before anyone clones, so ready is the branch picker, which only a clone has.
  const picker = page.getByRole("button", { name: "main", exact: true })
  const clone = header.getByRole("button", { name: "Clone" })
  await expect(picker.or(clone)).toBeVisible({ timeout: 60_000 })
  if (await clone.isVisible()) await clone.click()
  await expect(picker).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText("Well hello there!")).toBeVisible({ timeout: 30_000 })
}

test("clone: two devices see the repository open on its README once Code Storage has it", { annotation: { type: "summary", description: "Two devices see a repository open on its README once it is cloned." } }, async ({ browser }) => {
  const alice = await browser.newContext({ recordVideo: { dir: test.info().outputPath("alice") } })
  const bob = await browser.newContext({ recordVideo: { dir: test.info().outputPath("bob") } })
  const [a, b] = [await alice.newPage(), await bob.newPage()]
  await recordActions(a, test.info(), "alice")
  await recordActions(b, test.info(), "bob")
  await openReady(a)
  // The second device needs no clone of its own: Electric delivers the row Alice's clone settled.
  await b.goto(REPO)
  await expect(b.getByText("Well hello there!")).toBeVisible({ timeout: 60_000 })
  await expect(b.getByRole("button", { name: "Clone" })).toHaveCount(0)
  await alice.close()
  await bob.close()
})

test("browse: a file from the listing, its lines, a reload, and the permalink at the head commit", { annotation: { type: "summary", description: "A file opens from the listing with its lines, survives a reload, and has a permalink at the head commit." } }, async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await openReady(page)
  await page.getByRole("link", { name: "index.html" }).first().click()
  await expect(page).toHaveURL(/\/octocat\/Spoon-Knife\/blob\/main\/index\.html$/)
  await expect(visibleText(page.getByRole("article", { name: "index.html", exact: true }), "<!DOCTYPE html>")).toBeVisible({ timeout: 30_000 })
  // A line anchor survives a reload: the URL is the view's location.
  await page.goto(`${REPO}/blob/main/index.html?L=3`)
  await expect(visibleText(page.getByRole("article", { name: "index.html", exact: true }), "<!DOCTYPE html>")).toBeVisible({ timeout: 30_000 })
  // Copy permalink runs `repo/copy` on this browser's engine, which then writes this tab's clipboard.
  await page.getByRole("button", { name: "Copy permalink" }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 30_000 })
    .toMatch(/\/octocat\/Spoon-Knife\/blob\/[0-9a-f]{40}\/index\.html\?L=3$/)
  const permalink = await page.evaluate(() => navigator.clipboard.readText())
  await page.goto(new URL(permalink).pathname + new URL(permalink).search)
  await expect(visibleText(page.getByRole("article", { name: "index.html", exact: true }), "<!DOCTYPE html>")).toBeVisible({ timeout: 30_000 })
  // Up the path trail, back to the README.
  await page.getByRole("link", { name: "Spoon-Knife" }).first().click()
  await expect(page.getByText("Well hello there!")).toBeVisible({ timeout: 30_000 })
})

test("refusals: a repository GitHub doesn't have says Not found, and so does a missing file", { annotation: { type: "summary", description: "A repository GitHub doesn't have, and a missing file, both say Not found." } }, async ({ page }) => {
  const name = `no-such-repo-${Date.now().toString(36)}`
  await page.goto(`/octocat/${name}`)
  const header = page.locator('header[aria-label="Repository"]')
  await expect(header).toContainText(`octocat / ${name}`, { timeout: 30_000 })
  // AppShell is a sibling route: this page has just the header's connection live region.
  await expect(page.getByRole("status", { name: "Connection", exact: true })).toHaveCount(1)
  await expect(header.getByRole("status", { name: "Connection", exact: true })).toHaveAttribute("aria-live", "polite")
  // About answers independently of a clone's launch, execution and Electric settlement.
  // Its unnamed status is distinct from Connection; status roles don't derive their name from their text.
  await expect(header.getByRole("status").filter({ hasText: /^Not found$/ })).toHaveText("Not found", { timeout: 30_000 })
  await header.getByRole("button", { name: "Clone", exact: true }).click()
  // The same header text cannot prove the requested clone finished: require its feed outcome and recovery action.
  const subject = `clone:github/octocat/${name}`
  const entry = page.locator(`[data-slot="toast"][data-subject="${subject}"]`)
  await expect(entry).toContainText(`Clone · octocat/${name} · Not found`, { timeout: 120_000 })
  await expect(entry.getByRole("button", { name: "Try again", exact: true })).toBeVisible()
  await expect(entry).not.toContainText("Requested")
  await page.reload()
  await page.getByRole("button", { name: /^Notifications/ }).click()
  const panel = page.getByRole("dialog", { name: "Notifications" })
  const failed = panel.locator(`[data-subject="${subject}"]`)
  await expect(failed).toContainText(`octocat/${name} · Not found`, { timeout: 30_000 })
  await expect(failed.getByRole("button", { name: "Try again", exact: true })).toBeVisible()
  await failed.getByRole("button", { name: "Dismiss", exact: true }).click()
  await expect(failed).toHaveCount(0)
  await page.reload()
  await page.getByRole("button", { name: /^Notifications/ }).click()
  await expect(panel).toBeVisible()
  await expect(failed).toHaveCount(0)
  await page.keyboard.press("Escape")
  await openReady(page)
  await page.goto(`${REPO}/blob/main/no-such-file.md`)
  await expect(page.getByText("Not found").first()).toBeVisible({ timeout: 30_000 })
})
