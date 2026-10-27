import { REPOSITORIES_SHAPE_ROUTE } from "../src/features/repo/contract"
import { shapeRows } from "./shape"
import { expect, test, visibleText } from "./fixtures"
import { baseURL, requires, writeHeaders } from "./target"
import { repositoryAbout } from "./repository-prerequisites"
import { expectConsoleError, expectServerError } from "./watch"

// Browsing a repository as Will reviewed it (docs/features/repo.md#the-page), against the real app, Worker, Postgres,
// Electric, GitHub and Code Storage:
// - the first visit uses the page: GitHub's folder, README and about panel before anyone clones the repository;
// - a clone is a workflow in the person's feed: a toast says how far it came, then why it stopped, with Try again;
// - a cloned copy without the Smithers app says it may be reclaimed, with Install;
// - a Markdown file opens as a document, its source one press away;
// - an HTML file shows as CodePen does, its page in a sandboxed frame that reaches neither the app nor the network.
// The first two run anywhere: they read only GitHub. The rest need Code Storage, which a local run has only when the
// dev server's environment holds the organization, and a deployment holds; each asks for a clone, a Member's request
// (worker/RepoApi.ts `canClone`), and waits on the `repo/clone` remote flow (worker/RepoApi.ts `start`,
// worker/flows/RepoClone.ts), which decides both ready and Not found.

const SPOON = "/octocat/Spoon-Knife"

/**
 * Opens Spoon-Knife, cloning it if no run has yet, and waits until the device has it ready: the branch picker, which
 * GitHub's preview of a repository nobody cloned doesn't have, and its README.
 */
const openSpoon = async (page: import("@playwright/test").Page) => {
  await page.goto(SPOON)
  const header = page.locator('header[aria-label="Repository"]')
  await expect(header).toContainText("octocat / Spoon-Knife", { timeout: 30_000 })
  const picker = page.getByRole("button", { name: "main", exact: true })
  const clone = header.getByRole("button", { name: "Clone" })
  await expect(picker.or(clone)).toBeVisible({ timeout: 60_000 })
  if (await clone.isVisible()) await clone.click()
  await expect(picker).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText("Well hello there!").first()).toBeVisible({ timeout: 30_000 })
}

test(
  "first visit: a repository nobody cloned shows its folder, README and about panel at once",
  { annotation: { type: "summary", description: "The first visit fills the page from GitHub, before any clone." } },
  async ({ page }) => {
    // octocat/linguist: a fork with a README, languages and contributors, which no test clones.
    await page.goto("/octocat/linguist")
    const about = page.locator('section[aria-label="About"]')
    await expect(about).toContainText("Language Savant", { timeout: 30_000 })
    await expect(about.getByRole("heading", { name: "Languages" })).toBeVisible()
    await expect(about.getByRole("list", { name: "Languages" })).toContainText("Ruby")
    await expect(about.getByRole("heading", { name: /^Contributors/ })).toBeVisible()
    await expect(about.getByRole("img", { name: "josh" })).toBeVisible()
    // GitHub's top folder, its README rendered under it, the default branch, the counts and the newest commit.
    await expect(page.getByRole("link", { name: "lib", exact: true })).toBeVisible()
    await expect(page.locator('article[aria-label="README.md"]')).toContainText("Linguist")
    await expect(page.getByText("master", { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/^\d[\d,]* Branch(es)?$/)).toBeVisible()
    await expect(page.locator('[aria-label="Head commit"]')).toContainText(/\d[\d,]* Commits?/)
    await expect(page.getByRole("button", { name: "Code" })).toBeVisible()
    // Never the empty card it used to be.
    await expect(page.getByText("Clone to browse files")).toHaveCount(0)
  },
)

test(
  "the header's bell: its own slot after Clone, never over it, at 1280 px and on a phone",
  { annotation: { type: "summary", description: "The bell sits in the header's last slot and never covers Clone." } },
  async ({ page, browser }) => {
    type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    const apart = (one: Box | null, two: Box | null) =>
      one !== null && two !== null &&
      (one.x + one.width <= two.x || two.x + two.width <= one.x || one.y + one.height <= two.y || two.y + two.height <= one.y)
    const check = async (tab: import("@playwright/test").Page) => {
      // octocat/linguist, which no test clones: its header offers Clone.
      await tab.goto("/octocat/linguist")
      const header = tab.locator('header[aria-label="Repository"]')
      const clone = header.getByRole("button", { name: "Clone" })
      const bell = header.getByRole("button", { name: /^Notifications/ })
      await expect(clone).toBeVisible({ timeout: 30_000 })
      await expect(bell).toBeVisible()
      // One bell, the header's: the page floats no other.
      await expect(tab.getByRole("button", { name: /^Notifications/ })).toHaveCount(1)
      expect(apart(await clone.boundingBox(), await bell.boundingBox())).toBe(true)
      return { clone: await clone.boundingBox(), bell: await bell.boundingBox() }
    }
    const wide = await check(page)
    // At 1280 px it is the row's last slot, right of Clone.
    expect(wide.bell!.x).toBeGreaterThanOrEqual(wide.clone!.x + wide.clone!.width)
    // A phone's width, in a window of its own that isn't recorded: the row wraps, and still nothing overlaps.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true })
    await check(await phone.newPage())
    await phone.close()
  },
)

test.describe("cloned repositories", () => {
  requires("codeStorage", "member")

  test(
    "the clone in the feed: a toast says how far it came, then why it stopped, with Try again",
    { annotation: { type: "summary", description: "A clone reports in the toasts, and a failed one offers Try again." } },
    async ({ page, request }) => {
      requires("absentRepository")
      test.setTimeout(180_000)
      const repository = await repositoryAbout("absentRepository")
      const [owner, name] = repository.split("/")
      expectServerError(404, `/api/repos/${repository}/about`)
      await page.goto(`/${repository}`)
      const header = page.locator('header[aria-label="Repository"]')
      await expect(header).toContainText(`${owner} / ${name}`, { timeout: 30_000 })
      // W12 missing-repository recovery deliberately removes Clone once absence is known (repo.md).
      await expect(page.getByText("Repository not found", { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(header.getByRole("button", { name: "Clone", exact: true })).toHaveCount(0)
      // Exercise the Member's actual admission API to retain the failed-clone/feed/retry coverage.
      const admitted = await request.post("/api/repos", { headers: writeHeaders(), data: { owner, name } })
      expect(admitted.ok()).toBe(true)
      const { cloneId } = await admitted.json() as { cloneId: string }
      const launched = await request.post("/api/repos/launch", { headers: writeHeaders(), data: { owner, name, cloneId } })
      expect(launched.ok()).toBe(true)
      const subject = `clone:github/${repository.toLowerCase()}`
      const toast = page.locator(`[data-slot="toast"][data-subject="${subject}"]`)
      await page.getByRole("button", { name: /^Notifications/ }).click()
      const entry = page.locator(`li[data-entry="${subject}"]`)
      await expect(entry).toContainText(`Clone · ${repository} · Not found`, { timeout: 60_000 })
      const shown = await toast.textContent({ timeout: 100 }).catch(() => null)
      if (shown !== null) expect(shown).toContain(`Clone · ${repository}`)
      await entry.getByRole("button", { name: new RegExp(`Clone · ${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click()
      type CloneRow = { id: string; attempt: string | number; status: string; failure: string | null }
      const current = async () => {
        const row = (await shapeRows<CloneRow>(request, REPOSITORIES_SHAPE_ROUTE)).find(row => row.id === `github/${repository.toLowerCase()}`)
        return row === undefined ? undefined : { ...row, attempt: Number(row.attempt) }
      }
      const before = await current()
      expect(before).toMatchObject({ status: "failed", failure: "not_found" })
      await entry.getByRole("button", { name: "Retry" }).click()
      // The first failure's text can survive the click. Require the new attempt's actual terminal receipt.
      await expect.poll(current, { timeout: 120_000 }).toMatchObject({
        attempt: before!.attempt + 1, status: "failed", failure: "not_found",
      })
      // Try again's new attempt raises the entry again, and stops for the same reason.
      await expect(entry).toContainText(`Clone · ${repository} · Not found`, { timeout: 120_000 })
      await expect(entry.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
      await expect(page.locator(`[data-slot="toast"][data-subject="${subject}"]`)).not.toContainText("Requested")
    },
  )

  test(
    "the reclaimable note: a copy without the Smithers app may be reclaimed, and Install opens the App's installation",
    { annotation: { type: "summary", description: "A cloned copy without the app says it may be reclaimed, with Install." } },
    async ({ page }) => {
      await openSpoon(page)
      const note = page.getByRole("note").filter({ hasText: "may be reclaimed" })
      await expect(note).toContainText("Until the Smithers app is installed, this copy may be reclaimed for space.")
      await expect(note.getByRole("link", { name: "Install" })).toHaveAttribute(
        "href",
        /^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/,
      )
      // The about panel and the counts sit beside the files, as on GitHub.
      await expect(page.locator('section[aria-label="About"]')).toContainText("This repo is for demonstration purposes only.")
      await expect(page.getByText(/^3 Branches$/)).toBeVisible()
    },
  )

  test(
    "Markdown: a file opens as a document, read-only here, and Code shows its source",
    { annotation: { type: "summary", description: "Markdown renders as a document; its source is one press away." } },
    async ({ page }) => {
      await openSpoon(page)
      await page.goto(`${SPOON}/blob/main/README.md`)
      const file = page.locator('article[aria-label="README.md"]')
      await expect(file.getByRole("heading", { name: "Well hello there!" })).toBeVisible({ timeout: 30_000 })
      // No branch to commit to on this page: the document can't be edited.
      await expect(file.locator('[contenteditable="true"]')).toHaveCount(0)
      await file.getByRole("button", { name: "Code", exact: true }).click()
      await expect(file.getByText("### Well hello there!")).toBeVisible()
      await expect(page.getByRole("link", { name: "Raw" })).toBeVisible()
    },
  )

  test(
    "HTML: Code, Preview and Split, the page live in a frame that can't reach the app or the network",
    { annotation: { type: "summary", description: "An HTML file shows live beside its source, sandboxed." } },
    async ({ page }) => {
      // These are the preview policy's intentional refusals, including our network probe below.
      expectConsoleError(`Loading the stylesheet '${new URL(`${SPOON}/blob/main/styles.css`, baseURL).href}' violates the following Content Security Policy directive: "style-src 'unsafe-inline'"`)
      expectConsoleError(`Loading the image '${new URL(`${SPOON}/blob/main/forkit.gif`, baseURL).href}' violates the following Content Security Policy directive: "img-src data: blob:"`)
      expectConsoleError("Connecting to 'https://example.com/' violates the following Content Security Policy directive")
      expectConsoleError("Fetch API cannot load https://example.com/. Refused to connect because it violates the document's Content Security Policy.")
      await openSpoon(page)
      await page.goto(`${SPOON}/blob/main/index.html`)
      const file = page.locator('article[aria-label="index.html"]')
      await expect(visibleText(file, "<!DOCTYPE html>")).toBeVisible({ timeout: 30_000 })
      await file.getByRole("button", { name: "Preview", exact: true }).click()
      const frame = file.locator('iframe[title="Preview of index.html"]')
      await expect(frame).toHaveAttribute("sandbox", "allow-scripts")
      const preview = page.frameLocator('iframe[title="Preview of index.html"]')
      await expect(preview.getByText("Fork me? Fork you, @octocat!")).toBeVisible()
      // Its scripts run in an opaque origin under the preview's policy: no app, no network.
      const inside = page.frames().find((candidate) => candidate.parentFrame() === page.mainFrame() && candidate.url() === "about:srcdoc")!
      expect(await inside.evaluate(() => {
        try {
          return String(window.parent.document.title)
        } catch {
          return "blocked"
        }
      })).toBe("blocked")
      expect(await inside.evaluate(() => fetch("https://example.com/").then(() => "fetched", () => "blocked"))).toBe("blocked")
      await file.getByRole("button", { name: "Split", exact: true }).click()
      await expect(file.locator(".sui-repo-html-split iframe")).toBeVisible()
      await expect(file.locator(".sui-repo-html-split .sui-code-view")).toBeVisible()
      await file.getByRole("button", { name: "Code", exact: true }).click()
      await expect(frame).toHaveCount(0)
    },
  )
})

test("repository code keeps Home, Code and Docs on a direct visit", async ({ page }) => {
  await page.goto("/smithersai/vibelang/tree/main")
  const tabs = page.getByRole("navigation", { name: "Repository pages" })
  await expect(tabs.getByRole("link")).toHaveText(["Home", "Code", "Docs"], { timeout: 60_000 })
  await expect(tabs.getByRole("link", { name: "Code", exact: true })).toHaveAttribute("aria-current", "page")
})
