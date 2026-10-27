import type { BrowserContext, Page, Request } from "@playwright/test"
import { VIEWS_ROUTE } from "../src/features/views/contract"
import { expect, test } from "./devices"
import { step } from "./fixtures"
import { liveDocs, renderedDocs } from "./live-docs"
import { baseURL, requires, target } from "./target"
import { expectServerError } from "./watch"

// A repository's docs (ruling AGENT-6, docs/features/docs.md) against the real app, ChatApi, Postgres and Electric, and
// the real outside world: GitHub says what `smithersai/vibelang`'s own home names (`"docs":
// "https://vibelang.sh/llms.txt"`), and ChatApi reads that index and its pages from vibelang.sh. Nothing here is
// scripted; expected titles, paths and Markdown come from the live index and page at run time.

const REPO = "/smithersai/vibelang"

/** Typing a person can follow in the video. */
const typing = { delay: 40 }

/** Signs this browser out: local development's signed-out cookie, or the run's session cookie dropped in a deployment. */
const signOut = async (page: Page) => {
  if (target === "deployment") return page.context().clearCookies()
  const secure = baseURL.startsWith("https:")
  await page.context().addCookies([
    { name: `${secure ? "__Host-" : ""}smithers_dev_signed_out`, value: "1", url: baseURL, secure },
  ])
}

/** Every view a tab of `context` asks ChatApi to add, as it asked. */
const viewsAdded = (context: BrowserContext) => {
  const added: Array<{ readonly id: string; readonly template: string; readonly props: Record<string, string> }> = []
  context.on("request", (request: Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === VIEWS_ROUTE) added.push(request.postDataJSON())
  })
  return added
}

test.describe("smithersai/vibelang's docs", () => {
  test(
    "visitor: the Docs tab lists the index, finds pages as you type, and opens one",
    { annotation: { type: "summary", description: "Signed out, VibeLang's Docs tab lists vibelang.sh's pages, searches them and shows one." } },
    async ({ page }) => {
      const source = await liveDocs(page)
      const docs = page.getByRole("region", { name: "Docs", exact: true })
      await step("Open smithersai/vibelang signed out", async () => {
        await signOut(page)
        await page.goto(REPO)
        await expect(page.locator('header[aria-label="Repository"]')).toContainText("smithersai / vibelang", { timeout: 30_000 })
      })
      await step("Docs: a tab beside Home and Code", async () => {
        const tabs = page.getByRole("navigation", { name: "Repository pages" })
        await expect(tabs.getByRole("link", { name: "Docs", exact: true })).toBeVisible({ timeout: 60_000 })
        await tabs.getByRole("link", { name: "Docs", exact: true }).click()
        await expect(page).toHaveURL(new RegExp(`${REPO}/docs$`))
        await expect(tabs.getByRole("link", { name: "Docs", exact: true })).toHaveAttribute("aria-current", "page")
      })
      await step("The index: every page, by section", async () => {
        await expect(page.getByRole("heading", { name: source.index.title, exact: true })).toBeVisible({ timeout: 60_000 })
        await expect(page.getByRole("link", { name: source.excluded.title, exact: true })).toBeVisible()
      })
      await step(`Search docs for ${source.query}: matches as you type`, async () => {
        const search = page.getByRole("searchbox", { name: "Search docs" })
        await search.pressSequentially(source.query, typing)
        await expect(page.getByRole("link", { name: source.selected.title, exact: true })).toBeVisible({ timeout: 30_000 })
        // The index's other pages are gone: only matches show.
        await expect(page.getByRole("link", { name: source.excluded.title, exact: true })).toHaveCount(0)
      })
      await step(`Open ${source.selected.title}: the page, rendered, with its site`, async () => {
        await page.getByRole("link", { name: source.selected.title, exact: true }).click()
        await expect(page).toHaveURL((url) => url.pathname === `${REPO}/docs${source.selected.path}`)
        await expect(docs.locator('[data-slot="docs-page-origin"]')).toHaveText("https://vibelang.sh")
        await expect(docs.getByRole("link", { name: "Open on site" })).toHaveAttribute("href", source.selected.url)
        await renderedDocs(docs, source)
      })
      await step("The page by its own URL, after a reload", async () => {
        await page.reload()
        await renderedDocs(docs, source)
      })
    },
  )

  test(
    "member: /docs shows a page of VibeLang's docs in the chat, rendered, and at full size",
    { annotation: { type: "summary", description: "/docs adds a live indexed page to the chat, its Markdown kept for every device." } },
    async ({ devices }) => {
      requires("personalModel", "ownConversation")
      const [a] = await devices.open("A")
      const source = await liveDocs(a.page)
      const added = viewsAdded(a.device.context)
      await step(`A searches docs for ${source.query}`, async () => {
        await a.openComposer()
        await a.composer.pressSequentially(`/docs smithersai/vibelang ${source.query}`, typing)
        await a.composer.press("Enter")
      })
      await expect.poll(() => added.length, { timeout: 60_000 }).toBe(1)
      expect(added[0]).toMatchObject({ template: "docs", props: { repository: "smithersai/vibelang", path: source.selected.path } })
      const view = a.page.locator(`[data-view="${added[0]!.id}"][data-template="docs"]`)
      await step("The page shows in the chat with its site", async () => {
        await renderedDocs(view, source)
        await expect(view.getByRole("link", { name: "Open on site" })).toHaveAttribute("href", source.selected.url)
      })
      await step("Full screen: the same page at full size", async () => {
        await view.getByRole("link", { name: "Full screen" }).click()
        await expect(a.page).toHaveURL(new RegExp(`/app/views/${added[0]!.id}`))
        await expect(a.page.getByRole("heading", { name: source.heading, exact: true, level: 1 })).toBeVisible({ timeout: 30_000 })
      })
    },
  )

  test(
    "the agent: asked about VibeLang's docs, it searches them and shows the page",
    { annotation: { type: "summary", description: "Asked how to retry in VibeLang, the agent calls app/docs/search and a docs page shows in the chat." } },
    async ({ devices }) => {
      requires("personalModel", "liveModel", "ownConversation")
      const word = devices.word
      const [a] = await devices.open("A")
      const added = viewsAdded(a.device.context)
      await a.askAndWaitTaken(`How do I retry a failing call in VibeLang? Show me its docs page, then reply with the word docs-${word}.`)
      await expect.poll(() => added.filter((view) => view.template === "docs").length, { timeout: 120_000 }).toBeGreaterThan(0)
      const shown = added.find((view) => view.template === "docs")!
      expect(shown.props).toMatchObject({ repository: "smithersai/vibelang" })
      await expect(a.page.locator(`[data-view="${shown.id}"][data-template="docs"] [data-slot="docs-page-view"]`)).toBeVisible({
        timeout: 60_000,
      })
    },
  )
})

test("a missing documentation page points to the available index", async ({ page }) => {
  expectServerError(404, "/api/repos/smithersai/vibelang/docs/page")
  await page.goto("/smithersai/vibelang/docs/bugbash3-bb2-docs-missing")
  await expect(page.getByRole("region", { name: "Docs", exact: true })).toContainText("Page unavailable · choose from the list")
  await expect(page.getByRole("searchbox", { name: "Search docs" })).toBeVisible()
})
