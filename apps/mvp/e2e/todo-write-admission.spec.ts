import { admissionRecords } from "./admissionRecords"
import { reloadAfter } from "../src/test/reloadTiming"
import { expect, test as base } from "./devices"
import { appHome, requires, stackRepository } from "./target"

const test = base.extend<{ records: (page: import("@playwright/test").Page) => Promise<void> }>({
  records: async ({}, use, info) => {
    const finish: Array<() => Promise<void>> = []
    await use(async page => { finish.push(await admissionRecords(page, info)) })
    for (const attach of finish) await attach()
  },
})

for (const delay of [0, 100, 300] as const) {
  test(`TODO commit and drop survive reload ${delay} ms after the press`, async ({ devices, records }) => {
    requires("writableStack", "member")
    test.setTimeout(180_000)
    const repo = stackRepository()
    const person = await devices.openNew("Maya", appHome())
    const page = person.page
    await records(page)
    const title = `bugbash4-w14w-todo-${delay}-${devices.word}`
    await page.goto(`/${repo}/stack`)
    await page.getByRole("button", { name: "New TODO", exact: true }).click()
    const draft = page.getByRole("form", { name: "TODO draft" })
    await draft.getByLabel("Title", { exact: true }).fill(title)
    await draft.getByLabel("Prompt", { exact: true }).fill("Keep the durable admission regression")
    await draft.getByRole("button", { name: "Commit", exact: true }).click()
    await reloadAfter(delay, () => page.reload())
    const row = page.getByRole("listitem").filter({ has: page.getByText(title, { exact: true }) })
    await expect.poll(async () => await row.count() > 0 || await page.getByRole("button", { name: "Retry", exact: true }).count() > 0, { timeout: 60_000 }).toBe(true)
    if (await page.getByRole("button", { name: "Retry", exact: true }).count()) await page.getByRole("button", { name: "Retry", exact: true }).click()
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(/T\d+/, { timeout: 60_000 })
    const number = (await row.textContent())!.match(/T(\d+)/)![1]!
    await row.getByRole("link", { name: title, exact: true }).click()
    await page.getByRole("button", { name: "Drop", exact: true }).click()
    await page.getByRole("dialog", { name: `Drop T${number}?` }).getByRole("button", { name: "Drop", exact: true }).click()
    await reloadAfter(delay, () => page.reload())
    await expect(page.locator("article[data-status=dropped]")).toBeVisible({ timeout: 60_000 })
  })
}
