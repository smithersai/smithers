// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test, type Page } from "./coverage"

// Actions inputs that reach MockActions' own paths in the browser (wiki/decisions/0016-coverage.md, "Actions and
// history arms in the browser"), over the real MockActions and memory engine.

/** The scripted agent's chat on the mock page, after its first answer. */
async function chat(page: Page) {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  await page.getByRole("dialog").getByRole("textbox", { name: "Message" }).fill("Hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("button", { name: "Expand Actions", exact: true })).toBeVisible()
  await expect(page.getByText("Answering", { exact: true })).toHaveCount(0)
  return page.locator('form[data-docked="true"]').getByRole("textbox", { name: "Message", exact: true })
}

test("a person's history read from the Actions pane runs on the page's own history", async ({ page }) => {
  await page.goto("/e2e/actions-runtime/index.html?role=contributor")
  await page.keyboard.press("ControlOrMeta+k")
  const message = page.getByRole("dialog").getByRole("textbox", { name: "Message", exact: true })
  await message.fill("Hello")
  await message.press("Enter")
  await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
  const actions = page.getByRole("region", { name: "Actions", exact: true })
  await actions.getByRole("button", { name: "show", exact: true }).click()
  await actions.getByRole("textbox", { name: "Action input" }).fill('{"what":"outline"}')
  await actions.getByRole("button", { name: "Run", exact: true }).click()
  const card = page.getByRole("button", { name: /Open show run/ })
  await expect(card).toContainText("Passed", { timeout: 15_000 })
  await card.click()
  await expect(actions.getByLabel("Result", { exact: true })).toContainText('"epics"')
})

test("the agent asked for a command its visitor may not run answers that it is unavailable", async ({ page }) => {
  const input = await chat(page)
  await input.fill('Run /plan {"how":"append","epic":"e1","newEpic":"","target":"","title":"t","task":""}')
  await input.press("Enter")
  await expect(page.getByText("Action unavailable.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: /Open Plan run/ })).toHaveCount(0)
})

test("the agent asked for a command with input that isn't JSON answers that it is unavailable", async ({ page }) => {
  const input = await chat(page)
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await expect(page.locator(".vl-nav-role")).toHaveText("Maintainer")
  await input.fill("Run /history {not json")
  await input.press("Enter")
  await expect(page.getByText("Action unavailable.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: /Open show run/ })).toHaveCount(0)
})
