import { expect, test } from "./devices"
import { step } from "./fixtures"
import { requires } from "./target"

test("Add project saves from the empty Projects dashboard and refreshes the signed-in roster", async ({ devices }) => {
  requires("devPeople", "devSignIn")
  const [owner, second] = await devices.openAs(`newcomer-${devices.word}`, "Owner", "Second device")
  const [visitor] = await devices.openVisitorAs(`newcomer-${devices.word}v`, "Visitor")
  const dashboard = (page: typeof owner.page) => page.getByRole("region", { name: "Projects", exact: true })
  const project = "example/idle-project"
  const region = dashboard(owner.page)
  const repository = region.getByLabel("Repository", { exact: true })
  const add = region.getByRole("button", { name: "Add project", exact: true })
  const status = region.locator("form").getByRole("status")

  await step("Open Projects and correct an invalid repository", async () => {
    await owner.page.goto("/app")
    await expect(region.getByText("No saved projects")).toBeVisible({ timeout: 30_000 })
    await repository.fill("invalid")
    await repository.press("Enter")
    await expect(status).toHaveText("Enter a repository as owner/repository.")
    await expect(repository).toHaveValue("invalid")
  })

  await step("Save the repository and repeat the same addition", async () => {
    await repository.fill("Example/Idle-Project")
    await repository.press("Enter")
    await expect(status).toHaveText("Project added.", { timeout: 30_000 })
    await expect(repository).toHaveValue("")
    await expect(region.getByRole("link", { name: `${project} Workbench` })).toBeVisible()
    await repository.fill(project)
    await add.click()
    await expect(status).toHaveText("Project added.", { timeout: 30_000 })
    await expect(region.getByRole("listitem")).toHaveCount(1)
  })

  await step("Open the saved roster on another device and keep it hidden for visitors", async () => {
    await dashboard(second.page).getByRole("button", { name: "Refresh projects" }).click()
    await expect(dashboard(second.page).getByRole("link", { name: `${project} Runs` })).toBeVisible({ timeout: 30_000 })
    await visitor.page.goto("/app")
    await expect(visitor.page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible()
    await expect(dashboard(visitor.page)).toHaveCount(0)
    await expect(visitor.page.getByRole("button", { name: "Add project", exact: true })).toHaveCount(0)
  })
})
