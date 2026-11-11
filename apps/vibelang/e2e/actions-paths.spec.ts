// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// Run input, start, follow and cancel failures from a faulty Actions service over the real MockActions
// (test/support/FaultyActions.vibe), on the actions fault host.
import { expect, test, type Page } from "./coverage"

test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? process.env.E2E_4502 ?? 4173}` })

async function pane(page: Page, fault?: string) {
  await page.goto(`/e2e/actions-runtime/index.html?role=contributor${fault === undefined ? "" : `&fault=${fault}`}`)
  await page.keyboard.press("ControlOrMeta+k")
  const input = page.getByRole("dialog").getByRole("textbox", { name: "Message", exact: true })
  await input.fill("Hello")
  await input.press("Enter")
  await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
  return page.getByRole("region", { name: "Actions", exact: true })
}

test("input that isn't JSON is refused, keeps the text, and clears when edited", async ({ page }) => {
  const actions = await pane(page)
  await actions.getByRole("button", { name: "Plan", exact: true }).click()
  const input = actions.getByRole("textbox", { name: "Action input" })
  await input.fill("{not json")
  await actions.getByRole("button", { name: "Run", exact: true }).click()
  await expect(actions.getByRole("alert")).toHaveText("Input isn't valid.")
  await expect(input).toHaveValue("{not json")
  await input.fill("{}")
  await expect(actions.getByRole("alert")).toHaveCount(0)
})

test("a run that fails to start says so; Run starts it", async ({ page }) => {
  const actions = await pane(page, "actions-start")
  await actions.getByRole("button", { name: "Post", exact: true }).click()
  await actions.getByRole("textbox", { name: "Action input" }).fill("Second try")
  await actions.getByRole("button", { name: "Run", exact: true }).click()
  await expect(actions.getByRole("alert")).toHaveText("Couldn't start the run.")
  await expect(actions.getByRole("textbox", { name: "Action input" })).toHaveValue("Second try")
  await actions.getByRole("button", { name: "Run", exact: true }).click()
  await expect(page.getByRole("button", { name: /Open Post run/ })).toBeVisible()
})

for (const [label, fault] of [["followed", undefined], ["whose follow is lost", "actions-follow"]] as const) test(`a run ${label} settles`, async ({ page }) => {
  const actions = await pane(page, fault)
  await actions.getByRole("button", { name: "Post", exact: true }).click()
  await actions.getByRole("textbox", { name: "Action input" }).fill("Followed")
  await actions.getByRole("button", { name: "Run", exact: true }).click()
  const card = page.getByRole("button", { name: /Open Post run/ })
  await expect(card).toBeVisible()
  await expect(card.getByText("Passed", { exact: true })).toBeVisible({ timeout: 15_000 })
})

test("a cancel that fails says so; the next cancel stops the run", async ({ page }) => {
  const actions = await pane(page, "actions-cancel")
  await actions.getByRole("button", { name: "Tour", exact: true }).click()
  await actions.getByRole("button", { name: "Run", exact: true }).click()
  await page.getByRole("button", { name: /Open Tour run/ }).click()
  await actions.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(actions.getByRole("alert")).toHaveText("Couldn't cancel the run.")
  await actions.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(actions.getByText("Cancelled", { exact: true }).first()).toBeVisible()
})

test("a run the agent requests whose read fails shows the failure in Actions; Retry loads it", async ({ page }) => {
  // Open the panel before the request: opening it afterwards also loads runs, clearing the prior read failure.
  const actions = await pane(page, "actions-read")
  const input = page.getByRole("textbox", { name: "Message", exact: true })
  await input.fill("Run /tour")
  await input.press("Enter")
  await expect(page.getByText("Tour requested.", { exact: true })).toBeVisible()
  await expect(actions.getByText("Couldn't load runs", { exact: false })).toBeVisible()
  await actions.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(actions.getByText("Couldn't load runs", { exact: false })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Open Tour run/ })).toBeVisible()
  await actions.getByRole("button", { name: /^Tour(?: \d+s)?$/ }).click()
  await expect(actions.getByRole("button", { name: /Tour #/ })).toBeVisible()
})
