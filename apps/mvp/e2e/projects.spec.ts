import { DEVICE_PERSON_HEADER } from "../src/features/auth/contract"
import { PROJECTS_ROUTE } from "../src/features/projects/contract"
import { expect, test } from "./devices"
import { step } from "./fixtures"
import { expectServerError } from "./watch"
import { requires } from "./target"

test("Projects: a private roster spans devices, organizations and idle projects while home chat stays available", async ({ devices }) => {
  requires("devPeople", "devSignIn")
  const person = `newcomer-${devices.word}` as const
  const [first, second] = await devices.openAs(person, "Laptop", "Phone")
  const [visitor] = await devices.openVisitorAs(`newcomer-${devices.word}b`, "Visitor")
  const [other] = await devices.openAs(`newcomer-${devices.word}c`, "Another account")
  const projects = ["example/idle-project", "another-org/also-idle", ...Array.from({ length: 8 }, (_, index) => `mobile/project-${index + 1}`)]
  const region = (page: typeof first.page) => page.getByRole("region", { name: "Projects", exact: true })

  await step("Save known projects for the signed-in account", async () => {
    const dashboard = region(first.page)
    const repository = dashboard.getByRole("textbox", { name: "Repository" })
    await expect(repository).toBeVisible({ timeout: 30_000 })
    await repository.fill(projects[0]!.toUpperCase())
    await repository.press("Enter")
    await expect(dashboard.getByText("Project added.")).toBeVisible({ timeout: 30_000 })
    await expect(dashboard.getByRole("link", { name: `${projects[0]} Workbench` })).toBeVisible({ timeout: 30_000 })
    for (const project of projects.slice(1)) {
      const response = await first.page.request.post(PROJECTS_ROUTE, {
        headers: { [DEVICE_PERSON_HEADER]: person },
        data: { project },
      })
      expect(response.status()).toBe(200)
    }
    expect(await (await first.page.request.get(PROJECTS_ROUTE)).json()).toEqual({ projects: [...projects].sort() })
    const swapped = await other.page.request.post(PROJECTS_ROUTE, {
      headers: { [DEVICE_PERSON_HEADER]: person },
      data: { project: "example/forged" },
    })
    expect(swapped.status()).toBe(401)
  })

  await step("Open the same roster on desktop and mobile", async () => {
    await second.page.setViewportSize({ width: 390, height: 700 })
    for (const tab of [first, second]) {
      await tab.page.goto("/app")
      const dashboard = region(tab.page)
      await expect(dashboard.getByRole("listitem")).toHaveCount(projects.length, { timeout: 30_000 })
      for (const project of projects) {
        await expect(dashboard.getByRole("link", { name: `${project} Workbench` })).toHaveAttribute("href", `/${project}/workbench`)
        await expect(dashboard.getByRole("link", { name: `${project} Runs` })).toHaveAttribute("href", `/${project}/runs`)
      }
      expect(await tab.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await expect(first.page.getByRole("link", { name: "Conversations" })).toBeVisible()
    await expect(first.page.getByRole("button", { name: /Queue/ })).toBeVisible()
  })

  await step("Scroll to the last project and open chat on a phone", async () => {
    const dashboard = region(second.page)
    await expect(dashboard.getByLabel("Loading project counts")).toHaveCount(0, { timeout: 30_000 })
    const last = dashboard.getByRole("listitem").last().getByRole("link", { name: /Runs$/ })
    await expect(last).not.toBeInViewport()
    await last.focus()
    await expect(last).toBeFocused()
    await expect(last).toBeInViewport()
    await second.page.keyboard.press("ControlOrMeta+k")
    await expect(second.composer).toBeInViewport({ timeout: 30_000 })
    await second.page.keyboard.press("Escape")
    await expect(second.composer).toBeHidden()
  })

  await step("Use project navigation and the home keyboard composer", async () => {
    await first.page.keyboard.press("ControlOrMeta+k")
    await expect(first.composer).toBeVisible({ timeout: 30_000 })
    await first.page.keyboard.press("Escape")
    await expect(first.composer).toBeHidden()
    const link = region(first.page).getByRole("link", { name: `${projects[0]} Runs` })
    // This saved-only fixture has no repository or flow installation on the local deployment.
    expectServerError(404, "/api/repos/example/idle-project/flows")
    const flowsAnswer = first.page.waitForResponse((r) => new URL(r.url()).pathname === "/api/repos/example/idle-project/flows")
    await link.focus()
    await expect(link).toBeFocused()
    await first.page.keyboard.press("Enter")
    await expect(first.page).toHaveURL(/\/example\/idle-project\/runs$/)
    expect((await flowsAnswer).status()).toBe(404)
  })

  await step("Keep the roster private and the visitor's sign-in gate in place", async () => {
    await other.page.goto("/app")
    await visitor.page.goto("/app")
    await expect(region(other.page).getByText("No saved projects")).toBeVisible({ timeout: 30_000 })
    await expect(visitor.page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible({ timeout: 30_000 })
    await expect(region(visitor.page)).toHaveCount(0)
    await expect(visitor.composer).toHaveCount(0)
    const origin = new URL(second.page.url()).origin
    const secure = origin.startsWith("https:")
    await second.device.context.addCookies([{
      name: `${secure ? "__Host-" : ""}smithers_dev_person`,
      value: `newcomer-${devices.word}c`,
      url: origin,
      secure,
    }])
    await second.reload()
    await expect(region(second.page).getByText("No saved projects")).toBeVisible({ timeout: 60_000 })
    await expect(region(second.page).getByRole("listitem")).toHaveCount(0)
  })
})
