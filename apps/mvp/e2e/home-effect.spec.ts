import type { Page } from "@playwright/test"
import { expect, step, test } from "./fixtures"
import { baseURL, requires, target } from "./target"

// Effect's home (docs/features/home.md#curated-homes): Smithers' curated home for `Effect-TS/effect`, which declares
// none, against the real app, ChatApi, Postgres and Electric. Who sees which section is ChatApi's to decide
// (`GET /api/repos/<owner>/<name>/home`), so each test signs in as local development's person for its audience
// (worker/DevChatApi.ts): signed out, a Member (a contributor) and a Maintainer, whose roles local development without
// the GitHub App keeps on every repository (decision 0079). Against a deployment a role is the person's role on the
// repository the page names, and the App isn't installed on Effect's: the run's test account, whatever its role on the
// deployment's own repository, sees Effect's landing page alone. The visitor runs wherever the app runs, signed out of
// this browser only; the contributor and maintainer need local development's people. "new branch" makes a branch on
// Code Storage's mirror of Effect, cloning it first when this deployment hasn't, so it also needs Code Storage.

const REPO = "/Effect-TS/effect"

/**
 * Who opens the page: signed out, or one of local development's people. Over https the Worker reads the `__Host-`
 * names (worker/SignIn.ts `cookieNames`), which a browser keeps only with `Secure`. Against a deployment this browser
 * drops the run's session cookie to be signed out; the session itself stays signed in for every other test.
 */
const as = async (page: Page, who: "signed out" | "teammate" | "maintainer") => {
  if (target === "deployment" && who === "signed out") return page.context().clearCookies()
  const secure = baseURL.startsWith("https:")
  const name = `${secure ? "__Host-" : ""}${who === "signed out" ? "smithers_dev_signed_out" : "smithers_dev_person"}`
  await page.context().addCookies([{ name, value: who === "signed out" ? "1" : who, url: baseURL, secure }])
}

const homeOf = (page: Page) => page.getByRole("region", { name: "Home", exact: true })

/** Opens Effect's page and waits for its home, as `audience`. */
const openHome = async (page: Page, audience: "everyone" | "contributor" | "maintainer") => {
  await page.goto(REPO)
  await expect(page.locator('header[aria-label="Repository"]')).toContainText("Effect-TS / effect", { timeout: 30_000 })
  await expect(homeOf(page)).toHaveAttribute("data-audience", audience, { timeout: 60_000 })
  await expect(homeOf(page)).toHaveAttribute("data-source", "curated")
}

/** The landing page every audience sees, below its own sections. */
const landing = async (page: Page) => {
  const home = homeOf(page)
  await expect(home.getByRole("heading", { name: "Effect", exact: true, level: 2 })).toBeVisible()
  await expect(home.getByText("Build production-ready applications in TypeScript.")).toBeVisible()
  await expect(home.getByText("npm install effect", { exact: true })).toBeVisible()
  await expect(home.getByRole("figure", { name: "fetch-user.ts" })).toContainText("Effect.retry")
  await expect(home.getByRole("link", { name: "Get started" })).toHaveAttribute("target", "_blank")
  await expect(home.getByRole("heading", { name: "Ecosystem" })).toBeVisible()
  await expect(home.getByRole("link", { name: "effect@4.0.5" })).toBeVisible()
  await expect(home.getByRole("link", { name: "Discord" }).first()).toBeVisible()
}

test.describe("Effect-TS/effect's home", () => {
  test(
    "visitor: a landing page, and nothing of the contributors' or maintainers'",
    { annotation: { type: "summary", description: "Signed out, Effect opens on its landing page: what it is, install, code, ecosystem and releases." } },
    async ({ page }) => {
      await step("Open Effect-TS/effect signed out", async () => {
        await as(page, "signed out")
        await openHome(page, "everyone")
      })
      await step("The landing page: Effect, install, an example, the ecosystem, releases", async () => {
        await landing(page)
        await page.getByRole("heading", { name: "Releases" }).scrollIntoViewIfNeeded()
      })
      await step("No contributor or maintainer section reached this browser, and no view to switch to", async () => {
        await expect(page.getByRole("region", { name: "Your work" })).toHaveCount(0)
        await expect(page.getByRole("region", { name: "Today" })).toHaveCount(0)
        await expect(page.getByRole("button", { name: "New branch" })).toHaveCount(0)
        await expect(page.getByRole("radiogroup", { name: "View as" })).toHaveCount(0)
      })
      await step("Code: the tree, one tab away", async () => {
        const tabs = page.getByRole("navigation", { name: "Repository pages" })
        await expect(tabs.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page")
        await expect(tabs.getByRole("link", { name: "Code" })).toHaveAttribute("href", `${REPO}/tree/main`)
      })
    },
  )

  test(
    "a role elsewhere: the landing page, and nothing of Effect's contributors' or maintainers'",
    { annotation: { type: "summary", description: "Roles are per repository: signed in with a role on this deployment's repository, Effect opens as a visitor sees it." } },
    async ({ page }) => {
      requires("outsideRoles")
      await step("Open Effect-TS/effect signed in, with a role on this deployment's repository alone", async () => {
        await openHome(page, "everyone")
      })
      await step("The landing page, as a visitor sees it", () => landing(page))
      await step("No contributor or maintainer section reached this browser", async () => {
        await expect(page.getByRole("region", { name: "Your work" })).toHaveCount(0)
        await expect(page.getByRole("region", { name: "Today" })).toHaveCount(0)
        await expect(page.getByRole("button", { name: "New branch" })).toHaveCount(0)
      })
    },
  )

  test(
    "contributor: their work above the landing page, and nothing of the maintainers'",
    { annotation: { type: "summary", description: "A Member sees Your work (the stack) above Effect's landing page; asking waits for the deployment's own repository." } },
    async ({ page }) => {
      requires("devPeople")
      await step("Open Effect-TS/effect as a Member", async () => {
        await as(page, "teammate")
        await openHome(page, "contributor")
      })
      await step("Your work, for contributors: the stack; asking, New TODO and Open an issue only on the deployment's own repository", async () => {
        const work = page.getByRole("region", { name: "Your work" })
        await expect(work.getByText("Contributors", { exact: true })).toBeVisible()
        await expect(work.locator("[data-panel='stack']")).toBeVisible({ timeout: 30_000 })
        // Asking from a home, and its prompt and app blocks, act only on the deployment's own repository
        // (decision 0079, src/features/auth/viewer.ts `ownRepository`), which Effect-TS/effect is not.
        await expect(work.getByRole("heading", { name: "What should we work on?" })).toHaveCount(0)
        await expect(work.getByRole("link", { name: "Ask Smithers about Effect…" })).toHaveCount(0)
        await expect(work.getByRole("link", { name: "New TODO" })).toHaveCount(0)
        await expect(work.getByRole("link", { name: "Open an issue" })).toHaveCount(0)
      })
      await step("No maintainer section", async () => {
        await expect(page.getByRole("region", { name: "Today" })).toHaveCount(0)
        await expect(page.getByRole("button", { name: "New branch" })).toHaveCount(0)
      })
      await step("Below: the landing page", () => landing(page))
      await step("View as: Contributor or User, never Maintainer", async () => {
        const views = page.getByRole("radiogroup", { name: "View as" })
        await expect(views.getByRole("radio")).toHaveText(["Contributor", "User"])
        await expect(views.getByRole("radio", { name: "Contributor" })).toHaveAttribute("aria-checked", "true")
        await views.getByRole("radio", { name: "User" }).click()
        await expect(homeOf(page)).toHaveAttribute("data-audience", "everyone")
        await expect(page.getByRole("region", { name: "Your work" })).toHaveCount(0)
        await landing(page)
      })
    },
  )

  test(
    "maintainer: the day first, with New branch, then their work and the landing page",
    { annotation: { type: "summary", description: "A Maintainer sees Today first: New branch (B), triage and runs; then Your work and the landing page." } },
    async ({ page }) => {
      requires("devPeople")
      await step("Open Effect-TS/effect as a Maintainer", async () => {
        await as(page, "maintainer")
        await openHome(page, "maintainer")
      })
      await step("Today, for maintainers: New branch with its key, triage, runs", async () => {
        const today = page.getByRole("region", { name: "Today" })
        await expect(today.getByText("Maintainers", { exact: true })).toBeVisible()
        await expect(today.getByRole("button", { name: "New branch" })).toHaveAttribute("aria-keyshortcuts", "B")
        // No GitHub App syncs Effect's issues on this dev server: the block says so.
        await expect(today.locator("[data-panel='issues']")).toContainText("Not synced")
        await expect(today.locator("[data-panel='runs']")).toBeVisible()
      })
      await step("Then Your work and the landing page", async () => {
        const sections = page.locator("[data-slot='repository-home-section']")
        await expect(sections.nth(0)).toHaveAttribute("aria-label", "Today")
        await expect(sections.nth(1)).toHaveAttribute("aria-label", "Your work")
        await landing(page)
      })
      await step("View as Contributor, then User, then back to Maintainer", async () => {
        const views = page.getByRole("radiogroup", { name: "View as" })
        await expect(views.getByRole("radio")).toHaveText(["Maintainer", "Contributor", "User"])
        await views.getByRole("radio", { name: "Contributor" }).click()
        await expect(homeOf(page)).toHaveAttribute("data-audience", "contributor")
        await expect(page.getByRole("region", { name: "Today" })).toHaveCount(0)
        await expect(page.getByRole("region", { name: "Your work" })).toBeVisible()
        await views.getByRole("radio", { name: "User" }).click()
        await expect(page.getByRole("region", { name: "Your work" })).toHaveCount(0)
        await landing(page)
        await views.getByRole("radio", { name: "Maintainer" }).click()
        await expect(page.getByRole("region", { name: "Today" })).toBeVisible()
      })
    },
  )
})

test.describe("Effect-TS/effect's home, New branch", () => {
  requires("devPeople", "codeStorage")

  test(
    "new branch: B makes a branch at main and opens its workspace",
    { annotation: { type: "summary", description: "A Maintainer presses B on Effect's home: a new branch at main, and its workspace opens." } },
    async ({ page }) => {
      test.setTimeout(900_000)
      const header = page.locator('header[aria-label="Repository"]')
      await step("Open Effect-TS/effect as a Maintainer", async () => {
        await as(page, "maintainer")
        await openHome(page, "maintainer")
      })
      await step("Clone it, when this deployment hasn't", async () => {
        const clone = header.getByRole("button", { name: "Clone" })
        if (await clone.isVisible()) {
          await clone.click()
          await expect(clone).toHaveCount(0, { timeout: 60_000 })
          await expect(header.getByRole("status", { name: "Cloning" })).toHaveCount(0, { timeout: 600_000 })
        }
        await expect(homeOf(page)).toHaveAttribute("data-source", "curated", { timeout: 60_000 })
      })
      await step("Press B: a new branch, and its workspace", async () => {
        await page.keyboard.press("b")
        await expect(page).toHaveURL(new RegExp(`${REPO}/tree/local-maintainer/[0-9a-z]{6}$`), { timeout: 120_000 })
        await expect(page.getByRole("navigation", { name: "Branch" })).toContainText("local-maintainer/", { timeout: 60_000 })
      })
    },
  )
})
