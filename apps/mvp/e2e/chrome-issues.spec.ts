import { expect } from "@playwright/test"
import { test } from "./fixtures"
import { requires, syncedRepository } from "./target"

for (const width of [390, 1280]) test.describe(`${width}px issues chrome`, () => {
  test.use({ viewport: { width, height: 844 } })
  test("issues has one way back", async ({ page }) => {
    requires("githubApp", "syncedRepository")
    await page.goto(`/${syncedRepository()}/issues`)
    await expect(page.getByRole("heading", { name: new RegExp(syncedRepository().replace("/", " / ")) })).toBeVisible()
    await expect(page.getByRole("link", { name: "Back to chat", exact: true })).toHaveCount(1)
    const bell = page.locator(".repo-header [data-slot=notification-bell]")
    await expect(bell).toHaveCount(1)
    await expect(page.locator(".root-bell")).toHaveCount(0)
    const heading = (await page.locator(".repo-header-name").boundingBox())!
    expect((await bell.boundingBox())!.y).toBeLessThan(heading.y + heading.height)
  })
})

for (const kind of ["issues", "pulls"] as const) test(`${kind}: a direct item visit keeps the bell inside its header`, async ({ page }) => {
  requires("githubApp", "syncedRepository")
  const repo = syncedRepository()
  await page.goto(`/${repo}/${kind}`)
  const pattern = `/${repo}/${kind === "issues" ? "issues" : "pull"}/`
  // New issue precedes the rows; choose a numbered item through its real href.
  let href: string | undefined
  await expect.poll(async () => {
    href = await page.locator("a[href]").evaluateAll((links, prefix) => links.map(link => link.getAttribute("href")!).find(href => href.startsWith(prefix) && /^\d+$/.test(href.slice(prefix.length))), pattern)
    return href
  }).toBeTruthy()
  await page.goto(href!)
  await expect(page.locator(".repo-header [data-slot=notification-bell]")).toBeVisible()
  await expect(page.locator(".root-bell")).toHaveCount(0)
})
