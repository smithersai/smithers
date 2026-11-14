// Playwright discovers and loads test files only by JavaScript/TypeScript extension.
// What the scripted agent asks the action host for, by input shape and by who asks (src/actions/MockActions.vibe
// `command`, `start` and the tour's guide step): a post's text, a JSON value that is no object, and a tour the agent
// starts that walks to its end.
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

async function chat(page: Page) {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  await page.getByRole("dialog").getByRole("textbox", { name: "Message" }).fill("Hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("button", { name: "Expand Actions", exact: true })).toBeVisible()
  await expect(page.getByText("Answering", { exact: true })).toHaveCount(0)
}

async function asContributor(page: Page) {
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await expect(page.locator(".vl-nav-role")).toHaveText("Contributor")
}

async function ask(page: Page, text: string) {
  const input = page.locator('form[data-docked="true"]').getByRole("textbox", { name: "Message", exact: true })
  await input.fill(text)
  await input.press("Enter")
}

async function result(page: Page, card: RegExp) {
  const run = page.getByRole("button", { name: card })
  await expect(run).toContainText("Passed")
  await run.click()
  return page.getByRole("region", { name: "Actions", exact: true }).getByLabel("Result", { exact: true })
}

test("a post the agent requests carries the text after the command", async ({ page }) => {
  await chat(page)
  await asContributor(page)
  await ask(page, "Run /post What is a tuple?")
  await expect(page.getByText("Post requested.", { exact: true })).toBeVisible()
  // The post goes to its run's own conversation, as live's does, not to this chat.
  await expect(page.getByText("What is a tuple?", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Open Post run/ })).toContainText("Passed")
})

test("a history read whose JSON is no object reads the outline", async ({ page }) => {
  await chat(page)
  await asContributor(page)
  await ask(page, "Run /history [1]")
  await expect(await result(page, /Open show run/)).toContainText('"epics"')
})

test("a tour the agent starts passes once it walks its last step", async ({ page }) => {
  // The agent's tour runs in its run's own conversation (`action-<id>`, as live's worker/apiObjects.vibe opens it),
  // which the page does not show, so nobody ends it: it walks every step and finishes. The page clock runs each
  // step's reading hold.
  test.setTimeout(120_000)
  await page.clock.install()
  await chat(page)
  await ask(page, "Run /tour")
  await expect(page.getByText("Tour requested.", { exact: true })).toBeVisible()
  const run = page.getByRole("button", { name: /Open Tour run/ })
  await expect(run).toBeVisible()
  await expect.poll(async () => {
    await page.clock.runFor(15_000)
    return run.textContent()
  }, { timeout: 90_000 }).toContain("Passed")
})
