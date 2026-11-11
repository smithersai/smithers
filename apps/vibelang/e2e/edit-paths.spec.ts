// Playwright discovers browser specs only by JS/TS extension.
import { expect, test } from "./coverage"

const wiki = (page: import("./coverage").Page) => page.getByRole("region", { name: "Wiki", exact: true })

test("saving an unchanged page says so and keeps the editor; Cancel closes it", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await page.getByRole("button", { name: "Wiki", exact: true }).click()
  await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
  const editor = wiki(page).getByRole("textbox", { name: "Edit Home" })
  const source = await editor.inputValue()
  await wiki(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(wiki(page).getByText("No changes.", { exact: true })).toBeVisible()
  await expect(editor).toHaveValue(source)
  await editor.fill(source + "\nNot kept.\n")
  await wiki(page).getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(wiki(page)).not.toContainText("Not kept.")
  await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
  await expect(editor).toHaveValue(source)
})

test("choosing a step in a run's trace shows that step's log", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  await page.getByRole("dialog").getByRole("textbox", { name: "Message" }).fill("Hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send", exact: true }).click()
  await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
  const pane = page.getByRole("region", { name: "Actions", exact: true })
  await pane.getByRole("button", { name: "Tour", exact: true }).click()
  await pane.getByRole("button", { name: "Run", exact: true }).click()
  await page.getByRole("button", { name: /Open Tour run/ }).click()
  await pane.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(pane.getByText("Cancelled", { exact: true }).first()).toBeVisible()
  const steps = pane.getByRole("list", { name: "Steps" }).getByRole("button")
  const logs = pane.getByLabel("Logs", { exact: true })
  const count = await steps.count()
  expect(count).toBeGreaterThan(0)
  for (let index = 0; index < count; index++) {
    const label = (await steps.nth(index).innerText()).trim()
    await steps.nth(index).click()
    await expect(logs).toHaveText(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · `))
  }
})

for (const way of ["typed", "picked"] as const) {
  test(`a ${way} /live command switches the app to live`, async ({ page }) => {
    await page.goto("/?agent=mock")
    await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
    await page.getByRole("dialog").getByRole("textbox", { name: "Message" }).fill("Hello")
    await page.getByRole("dialog").getByRole("button", { name: "Send", exact: true }).click()
    const composer = page.locator('form[data-docked="true"]')
    const input = composer.getByRole("textbox", { name: "Message", exact: true })
    if (way === "typed") {
      await input.fill("/live")
      await input.press("Enter")
    } else {
      await input.fill("/")
      await composer.getByRole("listbox", { name: "Commands", exact: true }).getByRole("option", { name: /Live mode/ }).click()
    }
    await expect(page).toHaveURL(/[?&]agent=live\b/)
  })
}
