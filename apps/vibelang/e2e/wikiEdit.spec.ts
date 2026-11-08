// Playwright discovers browser specs only by JS/TS extension.
import { expect, test } from "@playwright/test"
const wiki = (page: import("@playwright/test").Page) => page.getByRole("region", { name: "Wiki", exact: true })

for (const level of ["maintainer", "contributor"] as const) {
  test(`${level} reviews Markdown and opens their own change`, async ({ page }, info) => {
    await page.goto("/?agent=mock")
    await page.getByRole("combobox", { name: "Visit as" }).selectOption(level)
    await page.getByRole("button", { name: "Wiki", exact: true }).click()
    await wiki(page).getByRole("link", { name: "Roadmap", exact: true }).first().click()
    await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
    const editor = wiki(page).getByRole("textbox", { name: "Edit Roadmap" })
    await expect(editor).toBeFocused()
    const source = await editor.inputValue()
    await editor.fill(source + "\nThe reviewed wiki edit.\n")
    await page.screenshot({ path: info.outputPath(`wiki-${level}-edit.png`), animations: "disabled" })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
    await wiki(page).getByRole("button", { name: level === "maintainer" ? "Save" : "Propose", exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect(wiki(page).getByRole("link", { name: "Review", exact: true })).toHaveAttribute("href", /\/pull\/[0-9]+$/)
    await expect(wiki(page)).not.toContainText("The reviewed wiki edit.")
    await page.screenshot({ path: info.outputPath(`wiki-${level}-review.png`), animations: "disabled" })
    await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
    await expect(editor).toHaveValue(source)
    await editor.fill(source + "\nDiscard this.\n")
    await page.keyboard.press("Escape")
    await expect(editor).toHaveCount(0)
    await expect(wiki(page)).not.toContainText("Discard this.")
  })
}

test("only contributors and maintainers see Edit; changing person closes the editor", async ({ page }) => {
  await page.goto("/?agent=mock")
  const picker = page.getByRole("combobox", { name: "Visit as" })
  await page.getByRole("button", { name: "Wiki", exact: true }).click()
  for (const role of ["viewer", "new", "community", "contributor", "maintainer"]) {
    await picker.selectOption(role)
    await expect(wiki(page).getByRole("button", { name: "Edit", exact: true })).toHaveCount(["contributor", "maintainer"].includes(role) ? 1 : 0)
  }
  await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
  await expect(wiki(page).getByRole("textbox", { name: "Edit Home" })).toBeVisible()
  await picker.selectOption("viewer")
  await expect(wiki(page).getByRole("textbox", { name: "Edit Home" })).toHaveCount(0)
})

test("the agent's chat draft is reviewed in the editor before the person submits", async ({ page }, info) => {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  const ask = page.getByRole("dialog", { name: "Ask the agent" })
  await ask.getByRole("textbox", { name: "Message" }).fill("Draft a wiki edit for the roadmap: add the wiki-edit brick")
  await ask.getByRole("button", { name: "Send", exact: true }).click()
  await page.getByRole("link", { name: "Review it", exact: true }).click()
  const editor = wiki(page).getByRole("textbox", { name: "Edit Roadmap" })
  await expect(editor).toHaveValue(/add the wiki-edit brick/)
  await page.screenshot({ path: info.outputPath("wiki-agent-draft.png"), animations: "disabled" })
  await wiki(page).getByRole("button", { name: "Propose", exact: true }).click()
  await expect(wiki(page).getByRole("link", { name: "Review", exact: true })).toBeVisible()
  await expect(wiki(page).locator(".vl-wiki-content")).not.toContainText("add the wiki-edit brick")
})
