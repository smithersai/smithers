import { expect, test } from "./devices"
import { faults, faultyApp } from "./faults"
import { requires, scratchRepository } from "./target"

// `/new`'s progress in the shared toast stack (decision 0124): Requested at the press, the engine's run while it makes
// the branch, Done once it did, and chat usable throughout. A start the engine never recorded stays Requested through a
// reload, which starts the same execution again; one it refused is Failed with Try again, under the same identity.

const toastOf = (page: import("@playwright/test").Page) => page.locator('[data-slot="toast"]').filter({ hasText: "New conversation" })

test("new branch: progress lasts until the branch exists, and chat stays usable", {
  annotation: { type: "summary", description: "Requested, then the run, then Done as the branch opens" },
}, async ({ devices }) => {
  requires("member", "githubScratch")
  test.setTimeout(180_000)
  const [person] = await devices.open("Maya")
  const page = person!.page
  await page.goto("/app")
  const composer = page.locator("textarea").first()
  const branch = `progress-new-${devices.word}`
  await composer.fill(`/new ${scratchRepository()} ${branch}`)
  await composer.press("Enter")
  const toast = toastOf(page)
  await expect(toast).toBeVisible()
  await expect(composer).toBeEnabled()
  await expect(page).toHaveURL(new RegExp(`/tree/${branch}$`), { timeout: 120_000 })
  await expect(toast).toContainText("Done")
})

test("a start the engine holds stays Requested through a reload, which starts it again", {
  annotation: { type: "summary", description: "No receipt yet is Requested, never Failed; the reload resumes it" },
}, async ({ devices }) => {
  requires("member", "githubScratch", "faults")
  test.setTimeout(180_000)
  const [person] = await devices.open("Maya")
  const page = person!.page
  await page.goto(faultyApp())
  await faults(page).engine.holdStarts()
  const composer = page.locator("textarea").first()
  const branch = `progress-held-${devices.word}`
  await composer.fill(`/new ${scratchRepository()} ${branch}`)
  await composer.press("Enter")
  const toast = toastOf(page)
  await expect(toast).toContainText("Requested")
  const subject = await toast.getAttribute("data-subject")
  await composer.fill("still usable")
  await expect(composer).toHaveValue("still usable")
  await page.reload()
  const same = page.locator(`[data-slot="toast"][data-subject="${subject}"]`)
  await expect(same).toBeVisible()
  await expect(same).not.toContainText("Failed")
  await expect(page).toHaveURL(new RegExp(`/tree/${branch}$`), { timeout: 120_000 })
  await expect(same).toContainText("Done")
})

test("a start the engine refuses is Failed with Try again, which keeps its identity", {
  annotation: { type: "summary", description: "The refusal shows at once; Try again admits the same execution" },
}, async ({ devices }) => {
  requires("member", "faults")
  const [person] = await devices.open("Maya")
  const page = person!.page
  await page.goto(faultyApp())
  await faults(page).engine.refuseStarts("conversation/new")
  const composer = page.locator("textarea").first()
  await composer.fill("/new octo/hello never-admitted")
  await composer.press("Enter")
  const toast = toastOf(page)
  await expect(toast).toContainText("Failed")
  const subject = await toast.getAttribute("data-subject")
  await toast.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(page.locator(`[data-slot="toast"][data-subject="${subject}"]`)).toContainText("Failed")
  await expect(toastOf(page)).toHaveCount(1)
})
