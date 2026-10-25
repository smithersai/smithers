import type { Page } from "@playwright/test"
import { expect, step, test } from "./fixtures"
import { baseURL, describeNeed, requires, target } from "./target"

// The VibeLang repository on Smithers (rulings SCOPE-12, SCOPE-13): what the visitor, contributor and maintainer
// journeys share. `smithersai/vibelang` is public and declares its own home in `.smithers/home.json`: a landing page
// for everyone, Contribute for contributors, Today for maintainers, and its docs (`https://vibelang.sh/llms.txt`). The
// page draws it from what GitHub says before anyone clones it (docs/features/home.md#before-a-clone), so these
// journeys read GitHub and vibelang.sh live: their words are VibeLang's main branch's.

export const REPO = "/smithersai/vibelang"

export type Who = "visitor" | "contributor" | "maintainer"

/**
 * Signs this browser in as `who`. Locally, local development's people (worker/DevChatApi.ts): signed out, a Member, a
 * Maintainer. Against a deployment a visitor is this browser without the run's session cookie; a contributor or a
 * maintainer is the run's test account, whose own view is the one its GitHub permission on smithersai/vibelang gives
 * (decision 0079): any signed-in account is at least a contributor on a public repository the App is installed on.
 */
export const as = async (page: Page, who: Who) => {
  if (target === "deployment") {
    if (who === "visitor") await page.context().clearCookies()
    return
  }
  const secure = baseURL.startsWith("https:")
  const name = `${secure ? "__Host-" : ""}${who === "visitor" ? "smithers_dev_signed_out" : "smithers_dev_person"}`
  const value = who === "visitor" ? "1" : who === "contributor" ? "teammate" : "maintainer"
  await page.context().addCookies([{ name, value, url: baseURL, secure }])
}

export type View = "everyone" | "contributor" | "maintainer"

/** The view the deployment opens VibeLang on for this browser's session (`GET /api/repos/<o>/<n>/home`). */
const deploymentView = async (page: Page): Promise<View> => {
  const response = await page.request.get(`${baseURL}/api/repos/smithersai/vibelang/home`)
  expect(response.status(), "the deployment answers who the test account is on smithersai/vibelang").toBe(200)
  return ((await response.json()) as { readonly audience: View }).audience
}

/**
 * The view a person opens on: locally the person `as` signed in; against a deployment, the test account's, which its
 * GitHub permission on smithersai/vibelang decides. A signed-in account is never a visitor there: GitHub gives anyone
 * `read` on a public repository, a contributor's view (decision 0079); a role on the deployment's own repository
 * decides nothing.
 */
export const ownView = async (page: Page, who: Who): Promise<View> => {
  if (who === "visitor") return "everyone"
  if (target === "local") return who
  const view = await deploymentView(page)
  expect(view, "a signed-in account opens smithersai/vibelang on a contributor's view or higher").not.toBe("everyone")
  return view
}

/**
 * Declares, in a test's body, that it needs a Maintainer or Admin of smithersai/vibelang: local development's
 * Maintainer, or against a deployment the test account when the deployment opens VibeLang for it on the maintainer
 * view; otherwise the test skips, blocked until someone with admin there grants the account maintain.
 */
export const requiresMaintainer = async (page: Page) => {
  if (target === "local") return requires("vibelangMaintainer")
  test.skip((await deploymentView(page)) !== "maintainer", describeNeed("vibelangMaintainer"))
}

export const homeOf = (page: Page) => page.getByRole("region", { name: "Home", exact: true })
export const tabsOf = (page: Page) => page.getByRole("navigation", { name: "Repository pages" })
export const viewsOf = (page: Page) => page.getByRole("radiogroup", { name: "View as" })

/** Opens VibeLang's page and waits for its own home, in `audience`. */
export const openHome = (page: Page, audience: "everyone" | "contributor" | "maintainer") =>
  step("Open smithersai/vibelang: it opens on its own home", async () => {
    await page.goto(REPO)
    await expect(page.locator('header[aria-label="Repository"]')).toContainText("smithersai / vibelang", { timeout: 30_000 })
    await expect(homeOf(page)).toHaveAttribute("data-source", "declared", { timeout: 60_000 })
    await expect(homeOf(page)).toHaveAttribute("data-audience", audience, { timeout: 60_000 })
  })

/** VibeLang's landing page, which every audience sees below its own sections. */
export const landing = async (page: Page) => {
  const home = homeOf(page)
  await expect(home.getByRole("heading", { name: "VibeLang", exact: true, level: 2 })).toBeVisible()
  await expect(home.getByText("Reliable TypeScript for the AI era, built on Effect.")).toBeVisible()
  await expect(home.getByText("npm create vibelang@latest my-app", { exact: true }).first()).toBeVisible()
  await expect(home.getByRole("figure", { name: "users.vibe" })).toContainText("service Users")
  await expect(home.getByRole("link", { name: "Get started" })).toHaveAttribute("target", "_blank")
  await expect(home.getByRole("heading", { name: "Why VibeLang" })).toBeVisible()
}

/** The contributors' section: how to set up, how a change lands, where to ask, and the way to ask about the code. */
export const contribute = async (page: Page) => {
  const section = page.getByRole("region", { name: "Contribute" })
  await expect(section.getByText("sh scripts/setup.sh", { exact: true })).toBeVisible()
  await expect(section.getByRole("heading", { name: "How a change lands" })).toBeVisible()
  await expect(section.getByText("A pull request; a person merges")).toBeVisible()
  await expect(section.getByRole("link", { name: "Issues" })).toHaveAttribute("href", "https://github.com/smithersai/vibelang/issues")
  await expect(section.getByRole("heading", { name: "Ask about the code" })).toBeVisible()
  return section
}

/** VibeLang's docs, in the Docs tab: the index, a search, and a page drawn in the app (docs/features/docs.md). */
export const readDocs = async (page: Page) => {
  await step("Docs: VibeLang's docs index, in the app", async () => {
    await tabsOf(page).getByRole("link", { name: "Docs", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${REPO}/docs$`))
    await expect(page.getByRole("heading", { name: "VibeLang", exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole("link", { name: "Installation", exact: true })).toBeVisible()
  })
  await step("Search the docs for retry, and open Retrying", async () => {
    await page.getByRole("searchbox", { name: "Search docs" }).pressSequentially("retry", { delay: 40 })
    await page.getByRole("link", { name: "Retrying", exact: true }).click({ timeout: 30_000 })
    await expect(page).toHaveURL(new RegExp(`${REPO}/docs/error-management/018-retrying\\.md$`))
    const docs = page.getByRole("region", { name: "Docs", exact: true })
    await expect(docs.getByRole("heading", { name: "Retrying" }).first()).toBeVisible({ timeout: 60_000 })
  })
}

/** The Code tab: VibeLang's tree at main, with its README, before or after any clone. */
export const readCode = (page: Page) =>
  step("Code: the tree at main, with the README", async () => {
    const code = tabsOf(page).getByRole("link", { name: "Code" })
    await expect(code).toHaveAttribute("href", `${REPO}/tree/main`)
    await code.click()
    await expect(page).toHaveURL(new RegExp(`${REPO}/tree/main`))
    await expect(tabsOf(page).getByRole("link")).toHaveText(["Home", "Code", "Docs"])
    await expect(page.getByRole("link", { name: "packages", exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('article[aria-label="README.md"]')).toContainText("VibeLang", { timeout: 30_000 })
  })
