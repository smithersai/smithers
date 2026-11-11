// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// Account failures come from a faulty Accounts service over the real mock (test/support/FaultyFactory.vibe): the first
// sign-in or Visit as choice, member list, grant and sign-out each fail once, or the first role subscription ends.
import { expect, test, type Page } from "./coverage"

const faultPage = (fault: string) => `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 4173)}/e2e/runtime/index.html?fault=${fault}`

async function visitAs(page: Page, role: string) {
  await page.getByRole("combobox", { name: "Visit as" }).selectOption(role)
  await expect(page.getByRole("combobox", { name: "Visit as" })).toHaveValue(role)
}

async function openPeople(page: Page) {
  await page.getByRole("button", { name: "Account", exact: true }).click()
  await page.getByRole("menuitem", { name: "People" }).click()
}

test("a failed sign-in offers Retry, which signs in", async ({ page }) => {
  await page.goto(faultPage("accounts"))
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const alert = page.getByRole("alert")
  await expect(alert).toContainText("Sign-in failed. GitHub didn’t answer.")
  await expect(page.getByRole("button", { name: "Account", exact: true })).toHaveCount(0)
  await alert.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
  await expect(alert).toHaveCount(0)
})

test("People, a role change and sign-out each recover from one failure with Retry", async ({ page }) => {
  await page.goto(faultPage("accounts"))
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await expect(page.getByRole("alert")).toContainText("Sign-in failed. GitHub didn’t answer.")
  await page.getByRole("alert").getByRole("button", { name: "Dismiss" }).click()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await visitAs(page, "maintainer")

  await openPeople(page)
  const toast = page.getByRole("alert")
  await expect(toast).toContainText("People couldn’t load.")
  await toast.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(toast).toHaveCount(0)
  const people = page.getByRole("region", { name: "People" })
  await expect(people.getByRole("combobox", { name: "Role for rira" })).toBeVisible()

  await people.getByRole("button", { name: "Maximize People" }).click()
  await expect(people).toHaveAttribute("data-maximized", "true")
  await people.getByRole("button", { name: "Minimize People" }).click()
  await expect(people).toHaveAttribute("data-maximized", "false")

  const rira = people.getByRole("combobox", { name: "Role for rira" })
  const before = await rira.inputValue()
  const target = before === "maintainer" ? "contributor" : "maintainer"
  await rira.selectOption(target)
  const dialog = page.getByRole("dialog", { name: new RegExp(`rira to ${target[0]!.toUpperCase()}${target.slice(1)}`) })
  await dialog.getByRole("button", { name: /^(Promote|Demote)$/ }).click()
  await expect(dialog.getByRole("alert")).toHaveText("Role change failed.")
  await dialog.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(rira).toHaveValue(target)

  await page.getByRole("button", { name: "Account", exact: true }).click()
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await expect(toast).toContainText("Sign out failed.")
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
  await toast.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
  await expect(toast).toHaveCount(0)
})

test("a lost role stream says so, and Retry resumes it so the next grant still shows", async ({ page }) => {
  await page.goto(faultPage("roles"))
  await visitAs(page, "maintainer")
  const toast = page.getByRole("alert")
  await expect(toast).toContainText("Connection lost.")
  await toast.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(toast).toHaveCount(0)
  await openPeople(page)
  const joss = page.getByRole("combobox", { name: "Role for joss" })
  await joss.selectOption("community")
  await page.getByRole("dialog", { name: "Promote joss to Community?" }).getByRole("button", { name: "Promote", exact: true }).click()
  await expect(joss).toHaveValue("community")
})

test("a lost role stream's notice can be dismissed", async ({ page }) => {
  await page.goto(faultPage("roles"))
  await visitAs(page, "maintainer")
  const toast = page.getByRole("alert")
  await expect(toast).toContainText("Connection lost.")
  await toast.getByRole("button", { name: "Dismiss" }).click()
  await expect(toast).toHaveCount(0)
})
