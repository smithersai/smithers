import type { Page } from "@playwright/test"
import { expect, step, test, visibleText } from "./fixtures"
import { requires, target } from "./target"
import { as, homeOf, landing, openHome, readCode, readDocs, REPO, tabsOf, viewsOf } from "./vibelang"

// The visitor's journey on the VibeLang repository (rulings SCOPE-12, SCOPE-13): someone signed out opens
// smithers.sh/smithersai/vibelang, sees VibeLang's landing page and nothing of its contributors' or maintainers', reads
// its docs in the app and browses its code. It reads GitHub and vibelang.sh live and needs no clone, so it runs
// wherever the app runs, against a deployment too (`BASE_URL=https://smithers.sh pnpm e2e:prod`).

test.describe("VibeLang on Smithers", () => {
  test(
    "visitor: VibeLang's landing page, its docs and its code, signed out",
    { annotation: { type: "summary", description: "Signed out, VibeLang opens on its landing page; Docs and Code are one tab away." } },
    async ({ page }) => {
      test.setTimeout(180_000)
      await as(page, "visitor")
      await openHome(page, "everyone")
      await step("The landing page: VibeLang, install, an example, why", () => landing(page))
      await step("Nothing of the contributors' or maintainers', and no view to switch to", async () => {
        await expect(page.getByRole("region", { name: "Contribute" })).toHaveCount(0)
        await expect(page.getByRole("region", { name: "Today" })).toHaveCount(0)
        await expect(page.getByRole("button", { name: "New branch" })).toHaveCount(0)
        await expect(viewsOf(page)).toHaveCount(0)
      })
      await step("Home, Code and Docs tabs", async () => {
        await expect(tabsOf(page).getByRole("link")).toHaveText(["Home", "Code", "Docs"])
        await expect(tabsOf(page).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page")
      })
      await readDocs(page)
      await step("Home comes back", async () => {
        await tabsOf(page).getByRole("link", { name: "Home" }).click()
        await expect(page).toHaveURL(new RegExp(`${REPO}$`))
        await expect(homeOf(page)).toHaveAttribute("data-audience", "everyone")
      })
      await readCode(page)
    },
  )

  // Will's bug bash, 2026-10-23: a visitor got 503 where a Member got 200, because a visitor's About read was anonymous
  // and kept per data center. VibeLang has the Smithers App, so its About is read with the App's token, once, and kept
  // for every data center (docs/features/repo.md#about).
  test(
    "visitor: a crowd of visitors opens VibeLang at once and every one is answered",
    { annotation: { type: "summary", description: "Thirty signed-out visitors ask for VibeLang at once; all get its About, then its page." } },
    async ({ page }) => {
      test.setTimeout(120_000)
      await as(page, "visitor")
      await step("Thirty visitors ask what GitHub says of VibeLang at once: every one is answered", async () => {
        const answers = await Promise.all(Array.from({ length: 30 }, () => page.request.get(`/api/repos${REPO}/about`)))
        expect(answers.map((answer) => answer.status())).toEqual(Array.from({ length: 30 }, () => 200))
        expect(await answers[0]!.json()).toMatchObject({ name: "smithersai/vibelang" })
      })
      await openHome(page, "everyone")
      await step("Its landing page draws from that answer", () => landing(page))
    },
  )
})

/**
 * Locally, clones VibeLang as local development's person unless a run already did, and waits for its files: a visitor
 * can't clone. A deployment has its clone.
 */
const cloned = (page: Page) =>
  step("VibeLang is cloned", async () => {
    await page.goto(`${REPO}/tree/main`)
    const picker = page.getByRole("button", { name: "main", exact: true })
    const clone = page.locator('header[aria-label="Repository"]').getByRole("button", { name: "Clone" })
    await expect(picker.or(clone)).toBeVisible({ timeout: 60_000 })
    if (await clone.isVisible()) await clone.click()
    await expect(picker).toBeVisible({ timeout: 180_000 })
  })

/** The requests a signed-out page has no business making: tracking a branch, and asking for a run's credential. */
const refusedRequests = (page: Page) => {
  const sent: Array<string> = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === "POST" && (path === "/api/branches" || /^\/api\/runs\/[^/]+\/credential$/.test(path))) {
      sent.push(path.replace(/\/runs\/[^/]+\//, "/runs/<id>/"))
    }
  })
  return sent
}

test.describe("VibeLang's files on Smithers", () => {
  test(
    "visitor: a file opened by its URL, Markdown as a document and code highlighted, signed out",
    { annotation: { type: "summary", description: "Signed out, a link to a file opens it: the README as a document, a config as highlighted code." } },
    async ({ page }) => {
      requires("codeStorage")
      test.setTimeout(300_000)
      if (target === "local") await cloned(page)
      await as(page, "visitor")
      const sent = refusedRequests(page)
      const openedAt = Date.now()
      await page.goto(`${REPO}/blob/main/README.md`)
      await step("The README, as a document", async () => {
        const readme = page.locator('article[aria-label="README.md"]')
        await expect(readme.getByRole("heading", { name: "VibeLang", level: 1 })).toBeVisible({ timeout: 30_000 })
        await expect(readme.getByRole("button", { name: "Preview", exact: true })).toHaveAttribute("aria-pressed", "true")
      })
      test.info().annotations.push({ type: "file shown", description: `${Date.now() - openedAt} ms after the page opened` })
      await step("Code is the one current tab", async () => {
        await expect(tabsOf(page).locator('[aria-current="page"]')).toHaveText(["Code"])
      })
      await step("A code file, highlighted", async () => {
        const path = "examples/react-vite/vite.config.ts"
        await page.goto(`${REPO}/blob/main/${path}`)
        const file = page.locator(`article[aria-label="${path}"]`)
        await expect(file.locator('.sui-code-view[data-language="typescript"]')).toBeVisible({ timeout: 30_000 })
        await expect(visibleText(file, "defineConfig")).toBeVisible()
        await expect(file.locator('.sui-code-view[data-state="ready"]')).toBeVisible()
        await expect(tabsOf(page).locator('[aria-current="page"]')).toHaveText(["Code"])
      })
      await step("No request a visitor can't make", () => Promise.resolve(expect(sent).toEqual([])))
    },
  )
})
