import { expect, test } from "./devices"
import { faults } from "./faults"
import { requires, stackRepository } from "./target"

// A faulty host capability rejects only the input receipt; delivery and every other store remain real.
test("a refused Drop stays Not sent and Retry delivers that press", async ({ devices }) => {
  requires("faults", "member", "writableStack")
  test.setTimeout(120_000)
  const person = await devices.openNew("Maya", "/app?faults")
  const page = person.page
  const repo = stackRepository()
  const title = `bugbash4-w14w-refusal-${devices.word}`
  await page.goto(`/${repo}/stack?faults`)
  await page.getByRole("button", { name: "New TODO", exact: true }).click()
  const draft = page.getByRole("form", { name: "TODO draft" })
  await draft.getByLabel("Title", { exact: true }).fill(title)
  await draft.getByLabel("Prompt", { exact: true }).fill("Keep the refused admission visible")
  await draft.getByRole("button", { name: "Commit", exact: true }).click()
  const row = page.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) })
  await expect(row).toContainText(/T\d+/, { timeout: 60_000 })
  const number = (await row.textContent())!.match(/T(\d+)/)![1]!
  await row.getByRole("link", { name: title, exact: true }).click()
  await faults(page).admission.refuseInputs()
  await page.getByRole("button", { name: "Drop", exact: true }).click()
  await page.getByRole("dialog", { name: `Drop T${number}?` }).getByRole("button", { name: "Drop", exact: true }).click()
  const failed = page.getByRole("list", { name: "Not sent", exact: true })
  await expect(failed).toContainText(`Drop T${number}`)
  await expect(failed.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  await faults(page).admission.heal()
  await failed.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.locator("article[data-status=dropped]")).toBeVisible({ timeout: 60_000 })
  await expect(failed).toHaveCount(0)
})
