import { expect, test } from "./devices"
import { admissionFaults } from "./faults"
import { requires, stackRepository, writeHeaders } from "./target"

// A faulty host capability rejects only the input receipt; delivery and every other store remain real.
test("a refused Drop stays Not sent and Retry delivers that press", async ({ devices }) => {
  requires("faults", "member", "writableStack")
  test.setTimeout(120_000)
  const person = await devices.openNew("Maya", "/app?admission-faults")
  const page = person.page
  const repo = stackRepository()
  const title = `bugbash4-w14w-refusal-${devices.word}`
  const created = await page.request.post(`/api/repos/${repo}/stack`, {
    headers: writeHeaders(), data: { op: "commit", opId: crypto.randomUUID(), title, prompt: "Keep the refused admission visible" },
  })
  expect(created.ok(), "the Drop fixture is a real committed TODO").toBe(true)
  const { number } = await created.json() as { number: number }
  await page.goto(`/${repo}/stack/${number}?admission-faults`)
  await expect(page.getByRole("button", { name: "Drop", exact: true })).toBeVisible()
  await admissionFaults(page).refuseInputs()
  await page.getByRole("button", { name: "Drop", exact: true }).click()
  await page.getByRole("dialog", { name: `Drop T${number}?` }).getByRole("button", { name: "Drop", exact: true }).click()
  const failed = page.getByRole("list", { name: "Not sent", exact: true })
  await expect(failed).toContainText(`Drop T${number}`)
  await expect(failed.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
  await admissionFaults(page).heal()
  await failed.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.locator("article[data-status=dropped]")).toBeVisible({ timeout: 60_000 })
  await expect(failed).toHaveCount(0)
})
