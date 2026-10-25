import { expect, step, test } from "./fixtures"
import { broken, requires } from "./target"
import { as, contribute, homeOf, landing, openHome, ownView, readCode, readDocs, REPO, viewsOf } from "./vibelang"

// The contributor's journey on the VibeLang repository (rulings SCOPE-13, SCOPE-14): a Member opens
// smithersai/vibelang on the contributors' view, with how to set up, how a change lands and where to ask above the
// landing page, can see it as a user sees it, and reads the docs and the code. Locally the Member is local development's
// teammate; against a deployment it is the run's test account, which must be a Member or above on the deployment's
// repository. Until per-repository home roles land, deployments of another repository are marked broken.

broken("vibelangRoles")

test.describe("VibeLang on Smithers", () => {
  test(
    "contributor: Contribute above the landing page, View as User, then the docs and the code",
    { annotation: { type: "summary", description: "A contributor sees Contribute first, may view as a user, and reads the docs and code." } },
    async ({ page }) => {
      requires("member")
      test.setTimeout(180_000)
      await as(page, "contributor")
      const own = ownView("contributor")
      await openHome(page, own)
      await step("View as Contributor, when theirs is higher", async () => {
        if (own === "contributor") return
        await viewsOf(page).getByRole("radio", { name: "Contributor" }).click()
        await expect(homeOf(page)).toHaveAttribute("data-audience", "contributor")
      })
      await step("Contribute: set up, how a change lands, where to ask, ask about the code", async () => {
        const section = await contribute(page)
        await expect(section.getByText("Contributors", { exact: true })).toBeVisible()
        await expect(page.getByRole("region", { name: "Today" })).toHaveCount(0)
      })
      await step("Ask about the code: the composer, at main", async () => {
        const ask = page.getByRole("region", { name: "Contribute" }).getByRole("link", { name: "Ask about VibeLang's compiler…" })
        await expect(ask).toHaveAttribute("href", `${REPO}/tree/main`)
      })
      await step("Below: the landing page", () => landing(page))
      await step("View as User: the landing page alone", async () => {
        await expect(viewsOf(page).getByRole("radio", { name: "Maintainer" })).toHaveCount(own === "maintainer" ? 1 : 0)
        await viewsOf(page).getByRole("radio", { name: "User" }).click()
        await expect(homeOf(page)).toHaveAttribute("data-audience", "everyone")
        await expect(page.getByRole("region", { name: "Contribute" })).toHaveCount(0)
        await landing(page)
      })
      await readDocs(page)
      await page.goto(REPO)
      await readCode(page)
    },
  )
})
