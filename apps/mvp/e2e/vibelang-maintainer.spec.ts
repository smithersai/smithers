import { expect, step, test } from "./fixtures"
import { broken, requires } from "./target"
import { as, contribute, homeOf, landing, openHome, REPO, viewsOf } from "./vibelang"

// The maintainer's journey on the VibeLang repository (rulings SCOPE-13, SCOPE-14): a Maintainer opens
// smithersai/vibelang on Today (New branch with its key, the issues, the runs), then Contribute and the landing page;
// switches down to the contributor and user views and back; and presses B for a new branch's workspace. Locally the
// Maintainer is local development's; against a deployment, the run's test account, a Maintainer or above on the
// deployment's repository. Other-repository deployments are marked broken until home roles are resolved per repository.
// New branch makes the branch on Code Storage's mirror of VibeLang,
// cloning it first when this deployment hasn't, so it needs Code Storage.

broken("vibelangRoles")

test.describe("VibeLang on Smithers", () => {
  test(
    "maintainer: Today first, then Contribute and the landing page; View as Contributor and User, and back",
    { annotation: { type: "summary", description: "A maintainer sees Today first, then Contribute and the landing page, and switches down to each view and back." } },
    async ({ page }) => {
      requires("maintainer")
      test.setTimeout(180_000)
      await as(page, "maintainer")
      await openHome(page, "maintainer")
      await step("Today, for maintainers: New branch with its key, the issues, the runs", async () => {
        const today = page.getByRole("region", { name: "Today" })
        await expect(today.getByText("Maintainers", { exact: true })).toBeVisible()
        await expect(today.getByRole("button", { name: "New branch" })).toHaveAttribute("aria-keyshortcuts", "B")
        await expect(today.locator("[data-panel='issues']")).toBeVisible()
        await expect(today.locator("[data-panel='runs']")).toBeVisible()
      })
      await step("Then Contribute and the landing page", async () => {
        const sections = page.locator("[data-slot='repository-home-section']")
        await expect(sections.nth(0)).toHaveAttribute("aria-label", "Today")
        await expect(sections.nth(1)).toHaveAttribute("aria-label", "Contribute")
        await contribute(page)
        await landing(page)
      })
      await step("View as Contributor, then User, then back to Maintainer", async () => {
        await expect(viewsOf(page).getByRole("radio")).toHaveText(["Maintainer", "Contributor", "User"])
        await viewsOf(page).getByRole("radio", { name: "Contributor" }).click()
        await expect(homeOf(page)).toHaveAttribute("data-audience", "contributor")
        await expect(page.getByRole("region", { name: "Today" })).toHaveCount(0)
        await expect(page.getByRole("region", { name: "Contribute" })).toBeVisible()
        await viewsOf(page).getByRole("radio", { name: "User" }).click()
        await expect(page.getByRole("region", { name: "Contribute" })).toHaveCount(0)
        await landing(page)
        await viewsOf(page).getByRole("radio", { name: "Maintainer" }).click()
        await expect(page.getByRole("region", { name: "Today" })).toBeVisible()
      })
    },
  )
})

test.describe("VibeLang on Smithers, New branch", () => {
  test(
    "maintainer: B makes a branch at main and opens its workspace",
    { annotation: { type: "summary", description: "A maintainer presses B on VibeLang's home: a new branch at main, and its workspace opens." } },
    async ({ page }) => {
      requires("maintainer", "codeStorage")
      test.setTimeout(900_000)
      await as(page, "maintainer")
      await openHome(page, "maintainer")
      const header = page.locator('header[aria-label="Repository"]')
      await step("Clone it, when this deployment hasn't", async () => {
        const clone = header.getByRole("button", { name: "Clone" })
        if (await clone.isVisible()) {
          await clone.click()
          await expect(clone).toHaveCount(0, { timeout: 60_000 })
          await expect(header.getByRole("status", { name: "Cloning" })).toHaveCount(0, { timeout: 600_000 })
        }
        await expect(homeOf(page)).toHaveAttribute("data-source", "declared", { timeout: 60_000 })
      })
      await step("Press B: a new branch at main, and its workspace", async () => {
        await page.keyboard.press("b")
        await expect(page).toHaveURL(new RegExp(`${REPO}/tree/[^/]+/[0-9a-z]{6}$`), { timeout: 120_000 })
        await expect(page.getByRole("navigation", { name: "Branch" })).toBeVisible({ timeout: 60_000 })
      })
    },
  )
})
