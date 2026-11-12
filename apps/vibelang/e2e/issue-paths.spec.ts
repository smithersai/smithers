// Playwright collects browser specs only by JS/TS extension.
// Issue paths the other journeys leave: each step's missing field, Back, a refused link, an action held behind a
// saved write, and the host's refusals (decision 0016, session 25).
import { expect, test } from "./coverage"
import type { Page } from "./coverage"

async function maintainer(page: Page) {
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await expect(page.locator(".vl-nav-role")).toHaveText("Maintainer")
}

function faulted(fault: string) {
  return `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4173)}/e2e/runtime/index.html?fault=${fault}`
}

test("each VIP step names its missing field, and Back keeps what was typed", async ({ page }) => {
  await page.goto("/?agent=mock")
  await maintainer(page)
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await page.getByRole("radio", { name: "VIPs", exact: true }).click()
  await page.getByRole("button", { name: "Propose a VIP", exact: true }).click()
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Named tuple patterns")
  const next = page.getByRole("button", { name: "Continue" })
  await next.click()
  await expect(page.getByText("Add a summary.", { exact: true })).toBeVisible()
  await page.getByRole("textbox", { name: "Summary", exact: true }).fill("Bind tuple elements by name.")
  await next.click()
  await expect(page.getByRole("textbox", { name: "Example", exact: true })).toBeVisible()
  await next.click()
  await expect(page.getByText("Add an example.", { exact: true })).toBeVisible()
  await page.getByRole("textbox", { name: "Example", exact: true }).fill("const pair = [1, 2]")
  await next.click()
  await next.click()
  await expect(page.getByText("Add prior art.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Back", exact: true }).click()
  await expect(page.getByText("Add prior art.", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Example", exact: true })).toHaveValue("const pair = [1, 2]")
  await page.getByRole("button", { name: "Back", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Summary", exact: true })).toHaveValue("Bind tuple elements by name.")
})

test("an issue linked under itself is refused and stays where it was", async ({ page }) => {
  await page.goto("/?agent=mock")
  await maintainer(page)
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await page.getByRole("link", { name: "Case branches on tuples", exact: true }).click()
  await page.getByRole("button", { name: "Link", exact: true }).click()
  const link = page.getByRole("dialog", { name: "Link #42" })
  await link.getByRole("textbox", { name: "Parent", exact: true }).fill("42")
  await link.getByRole("button", { name: "Link", exact: true }).click()
  await expect(link.getByRole("alert")).toContainText("Choose another parent.")
  await expect(link.getByRole("textbox", { name: "Parent", exact: true })).toHaveValue("42")
  await link.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(link).toHaveCount(0)
  await expect(page.getByRole("link", { name: "#38 Effect-native modules" }).first()).toBeVisible()
})

test("a saved write that lost its answer holds a new issue and a link until Retry", async ({ page }) => {
  await page.goto(faulted("issue-write"))
  await maintainer(page)
  await page.getByRole("button", { name: "Issues", exact: true }).click()
  await page.getByRole("button", { name: "New issue", exact: true }).click()
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Held behind its retry")
  await page.getByRole("textbox", { name: "Summary", exact: true }).fill("One write at a time.")
  await page.getByRole("button", { name: "New issue", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Couldn't save. Retry.")
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Issues", exact: true }).first().click()
  await page.getByRole("link", { name: "‹ Issues", exact: true }).click()
  await page.getByRole("button", { name: "New issue", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Retry the saved action.")
  await page.getByRole("link", { name: "Case branches on tuples", exact: true }).click()
  await page.getByRole("button", { name: "Link", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Link #42" })).toHaveCount(0)
  await expect(page.getByRole("alert")).toContainText("Retry the saved action.")
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.getByRole("heading", { name: /Held behind its retry/ })).toBeVisible()
})

for (const [fault, error] of [
  ["issue-forbidden", "Not allowed"],
  ["issue-closed", "Issue closed."],
  ["issue-no-model", "Review unavailable"],
] as const) {
  test(`a comment the host refuses reads "${error}" and is not shown`, async ({ page }) => {
    await page.goto(faulted(fault))
    await maintainer(page)
    await page.getByRole("button", { name: "Issues", exact: true }).click()
    await page.getByRole("link", { name: "Case branches on tuples", exact: true }).click()
    await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Refused by the host.")
    await page.getByRole("textbox", { name: "Comment", exact: true }).press("ControlOrMeta+Enter")
    await expect(page.locator(".sui-issue-form-error")).toContainText(error)
    await expect(page.locator(".sui-item-conv-comments")).not.toContainText("Refused by the host.")
  })
}
