import { expect, test, type Page } from "@playwright/test"

const stage = (page: Page, step: number) => expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(step))
const slash = async (page: Page, command: string) => {
  if (await page.locator(".guide-shell").getAttribute("data-conversation-open") !== "true") await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.keyboard.press("Enter")
}
// Only prerequisite lessons use the skeleton's explicit signals. Librarian always uses the real install.
const reachLibrary = async (page: Page) => {
  await stage(page, 1)
  for (const [index, signal] of ["identity.signed-in", "repository.ready", "issues.opened", "file.opened"].entries()) {
    await slash(page, `/onboarding.act signal ${signal}`)
    await stage(page, index + 2)
  }
}

for (const door of ["keyboard", "slash"] as const) test(`Librarian ${door} install persists and replay uses the installed shelf`, async ({ page }) => {
  await page.goto("/")
  await reachLibrary(page)
  await slash(page, "/plugins")
  const library = page.locator(".guide-library")
  await expect(library.locator('[data-plugin="librarian"]')).toBeVisible()
  await expect(library.locator(".plugin-card")).toHaveCount(1)
  await stage(page, 5)
  await expect(page.locator('[data-message-step="5"] .guide-step-done')).toHaveCount(0)
  if (door === "slash") await slash(page, "/plugins.install librarian")
  else {
    await page.keyboard.press("Escape")
    // Reach the native install control using only keyboard traversal.
    const install = library.getByTestId("plugin-install-librarian")
    for (let i = 0; i < 50 && !(await install.evaluate(node => node === document.activeElement)); i++) await page.keyboard.press("Tab")
    await expect(install).toBeFocused()
    await page.keyboard.press("Enter")
  }
  await expect(page.locator('[data-message-step="5"] .guide-step-done').first()).toBeVisible()
  await stage(page, 6)
  await page.reload()
  await stage(page, 6)
  await expect(page.getByTestId("plugin-rail-wiki").first()).toBeAttached()
  /*
   * The Librarian's second rail entry opens /history.show, which is a cloud-only
   * flow: on this local host availableRail drops it rather than offering a door
   * that cannot open. The generator itself (/history.bootstrap) is registered.
   */
  await expect(page.getByTestId("plugin-rail-history.show")).toHaveCount(0)
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-flows", /history\.bootstrap/)
  await slash(page, "/tut")
  await page.keyboard.press("Escape")
  await page.keyboard.press("ArrowRight")
  await reachLibrary(page)
  await slash(page, "/plugins")
  await expect(library.locator('[data-plugin="librarian"]')).toHaveAttribute("data-installed", "true")
  await stage(page, 5)
  await slash(page, "/plugins.install librarian")
  await stage(page, 6)
})

test("real slash install survives reload and completes an already-installed replay", async ({ page }) => {
  await page.goto("/")
  await reachLibrary(page)
  await slash(page, "/plugins.install librarian")
  await stage(page, 6)
  await page.reload()
  await stage(page, 6)
  await slash(page, "/tut")
  await page.keyboard.press("Escape")
  await page.keyboard.press("ArrowRight")
  await reachLibrary(page)
  await slash(page, "/plugins")
  await expect(page.locator('.guide-library [data-plugin="librarian"]')).toHaveAttribute("data-installed", "true")
  await slash(page, "/plugins.install librarian")
  await stage(page, 6)
})
