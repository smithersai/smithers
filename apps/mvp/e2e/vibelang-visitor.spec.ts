import type { Page } from "@playwright/test"
import { expect, step, test } from "./fixtures"
import { meets, requires, target } from "./target"
import { as, homeOf, landing, openHome, readCode, readDocs, REPO, tabsOf, viewsOf } from "./vibelang"

// The visitor's journey on the VibeLang repository (rulings SCOPE-12, SCOPE-13): someone signed out opens
// smithers.sh/smithersai/vibelang, sees VibeLang's landing page and nothing of its contributors' or maintainers', reads
// its docs in the app and browses its code. It reads GitHub and vibelang.sh live and needs no clone, so it runs
// wherever the app runs, against a deployment too (`BASE_URL=https://smithers.sh pnpm e2e:prod`).

test.describe("VibeLang on Smithers", () => {
  test(
    "visitor: VibeLang's landing page, its docs and its code, signed out",
    { annotation: { type: "summary", description: "Signed out, VibeLang opens on its landing page; Docs and Code are one tab away." } },
    async ({ page, browserLog }) => {
      test.setTimeout(180_000)
      page.context().on("response", async (response) => {
        if (new URL(response.url()).pathname !== `/api/repos${REPO}/about`) return
        const answer = await response.json().catch(() => undefined) as { home?: string | null } | undefined
        let docs = false
        try { docs = typeof JSON.parse(answer?.home ?? "null")?.docs === "string" } catch { /* Record an unreadable declaration without its contents. */ }
        browserLog.push(`visitor.about ${JSON.stringify({ status: response.status(), home: typeof answer?.home === "string", docs })}`)
      })
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
        await expect(tabsOf(page).getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page")
      })
      await readDocs(page)
      await step("Home comes back", async () => {
        await tabsOf(page).getByRole("link", { name: "Home", exact: true }).click()
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
    const clone = page.locator('header[aria-label="Repository"]').getByRole("button", { name: "Clone", exact: true })
    await expect.poll(async () => (await picker.isVisible()) || (await clone.isVisible()), { timeout: 60_000 }).toBe(true)
    if (await clone.isVisible()) await clone.click()
    await expect(picker).toBeVisible({ timeout: 180_000 })
  })

/** The requests a signed-out page has no business making: tracking a branch, and asking for a run's credential. */
const refusedRequests = (page: Page) => {
  const sent: Array<string> = []
  const personal = /^\/api\/shapes\/(runs|flows|flow-drafts|notifications|my-conversations|github-writes|triage-settings|actions|personal-model|spend-alerts)(\/|$)/
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (personal.test(path) || (request.method() === "POST" && (path === "/api/branches" || /^\/api\/runs\/[^/]+\/credential$/.test(path)))) {
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
        await expect(readme.getByRole("heading", { name: "VibeLang", exact: true, level: 1 })).toBeVisible({ timeout: 30_000 })
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
        const code = file.locator('.sui-code-view[data-language="typescript"]')
        await expect(code).toBeVisible({ timeout: 30_000 })
        // Find the call on the export line, rather than also matching its import.
        const exportedConfig = code.locator("[data-line]").filter({ hasText: /^export default defineConfig/ })
        await expect(exportedConfig.getByText("defineConfig", { exact: true })).toBeVisible()
        await expect(code).toHaveAttribute("data-state", "ready")
        await expect(tabsOf(page).locator('[aria-current="page"]')).toHaveText(["Code"])
      })
      await step("No request a visitor can't make", () => Promise.resolve(expect(sent).toEqual([])))
    },
  )
})

for (const who of ["visitor", "contributor"] as const) {
  test(`repository pages: ${who} sees navigation, VibeLang's synced lists and no deployment-only links`, async ({ page }) => {
    if (who === "contributor") requires("member")
    test.setTimeout(180_000)
    const synced = !meets("noGitHubApp")
    await as(page, who)
    const actionsRequests: string[] = []
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/shapes/actions") actionsRequests.push(request.url())
    })
    for (const path of ["issues", "pulls", "stack", "issues/new", "settings/secrets", "actions", "tree/main"]) {
      await step(`Open ${path}`, async () => {
        await page.goto(`${REPO}/${path}`)
        const header = page.locator('header[aria-label="Repository"]')
        await expect(header).toContainText("smithersai / vibelang", { timeout: 30_000 })
        await expect(tabsOf(page).getByRole("link")).toHaveText(["Home", "Code", "Docs"], { timeout: 60_000 })
        await expect(header.getByRole("link", { name: "Secrets", exact: true })).toHaveCount(0)
        await expect(header.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0)
        // VibeLang has the Smithers App, so a deployment syncs its issues and pull requests (decision 0079 slice 1b): its
        // own lists, never the frame that sends people to GitHub's. A dev server without the App syncs no repository
        // but its own: there they send people to GitHub's.
        if (path === "issues" || path === "pulls") {
          const text = path === "issues" ? "Issues for this repository are on GitHub." : "Pull requests for this repository are on GitHub."
          const toGitHub = page.getByRole("link", { name: text, exact: true })
          if (!synced) await expect(toGitHub).toHaveAttribute("href", `https://github.com/smithersai/vibelang/${path}`)
          else {
            await expect(page.getByRole("main", { name: path === "issues" ? "Issues" : "Pull requests" })).toBeVisible()
            await expect(toGitHub).toHaveCount(0)
          }
        }
        if (path === "issues/new" && !synced) {
          await expect(page.getByRole("link", { name: "Open an issue on GitHub", exact: true })).toHaveAttribute("href", "https://github.com/smithersai/vibelang/issues/new")
          await expect(page.getByRole("button", { name: "Create issue", exact: true })).toHaveCount(0)
        }
        if (path === "issues/new" && synced) {
          await expect(page.getByRole("link", { name: "Open an issue on GitHub" })).toHaveCount(0)
          // Anyone signed in may open one (a Guest and up); a visitor is asked to sign in.
          if (who === "contributor") await expect(page.getByRole("button", { name: "Create issue", exact: true })).toBeVisible({ timeout: 30_000 })
          else await expect(page.getByRole("link", { name: "Sign in with GitHub" }).or(page.getByRole("button", { name: "Sign in with GitHub" })).first()).toBeVisible({ timeout: 30_000 })
        }
        if (path === "stack") await expect(page.getByText("Members can make TODOs.", { exact: true })).toBeVisible()
        // The refusal is the page's empty state, whose title is text, as the stack's is.
        if (path === "settings/secrets") await expect(page.getByText("You can't see this repository's secrets.", { exact: true })).toBeVisible()
      })
    }
    await page.goto(REPO)
    await expect(homeOf(page)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole("link", { name: "Ask about this repository", exact: true })).toHaveCount(0)
    expect(actionsRequests).toEqual([])
  })
}
