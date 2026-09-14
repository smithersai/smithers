import type { Page } from "@playwright/test"
import { scenario } from "./coverage/types"
import { command, expect, openApp, openComposer, test } from "./support"

const boot = async (page: Page): Promise<void> => {
  await openApp(page)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
}

test(
  "theme and palette survive an immediate reload",
  scenario("local-appearance-immediate-reload", {
    capabilities: [],
    description: "Reloads immediately after real appearance commands without a settling delay.",
    coverage: [
      "host:local", "host:production", "door:slash", "path:persistence", "action:appearance.theme",
      "action:appearance.dark-mode", "dimension:immediate-reload", "evidence:persisted-appearance-after-reload"
    ]
  }),
  async ({ page }) => {
    await boot(page)
    await command(page, "/appearance.theme paper")
    const before = await page.locator("html").getAttribute("data-theme")
    await command(page, "/appearance.dark-mode")
    const expectedTheme = before === "dark" ? "light" : "dark"
    await expect(page.locator("html")).toHaveAttribute("data-theme", expectedTheme)
    await expect(page.locator("html")).toHaveAttribute("data-palette", "paper")
    await page.reload()
    await expect(page.locator("html")).toHaveAttribute("data-theme", expectedTheme)
    await expect(page.locator("html")).toHaveAttribute("data-palette", "paper")
  }
)

test(
  "composer draft survives an immediate reload while the overlay stays closed",
  scenario("local-composer-draft-immediate-reload", {
    capabilities: [],
    coverage: [
      "host:local", "host:production", "door:user-only", "path:persistence", "action:palette.open",
      "dimension:composer-draft", "dimension:immediate-reload", "evidence:persisted-draft-after-reload"
    ]
  }),
  async ({ page }) => {
    await boot(page)
    await openComposer(page)
    await page.getByTestId("composer-input").fill("draft survives immediate reload")
    await page.reload()
    await expect(page.getByTestId("composer-input")).toBeHidden()
    await openComposer(page)
    await expect(page.getByTestId("composer-input")).toHaveValue("draft survives immediate reload")
  }
)
