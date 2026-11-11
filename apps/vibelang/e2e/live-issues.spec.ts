// Playwright collects browser specs only by JS/TS extension.
// The issues screen in live mode, on worker/Issues.vibe's production route and durable engine in workerd
// (test/workerd/live-issues.vibe, served beside the preview build by test/support/liveSite.vibe). A write the page
// never heard back from is kept in the address bar; after a reload the server's run record restores it.
import { expect, test } from "./coverage"
import { readFileSync } from "node:fs"
const label: string = JSON.parse(readFileSync(new URL("../test/recordings/issues.json", import.meta.url), "utf8")).label
import type { Page } from "./coverage"

const origins: Record<string, string> = JSON.parse(process.env.LIVE_ISSUES_TEST_ORIGINS!)
// Playwright runs this file in order per project; each project owns its host and starts every case with no fault set.
test.beforeEach(async ({ page }, info) => { await page.request.post(origins[info.project.name]! + "/__fault?writes=0") })

async function open(page: Page, origin: string, query: string) {
  await page.addInitScript(() => localStorage.setItem("vibelang:toured", "yes"))
  await page.goto(origin + "/?" + query)
}

/** One write as the page sends it, with the page's origin. */
async function write(page: Page, origin: string, request: Record<string, unknown>) {
  return page.request.post(origin + "/api/issues", { headers: { origin }, data: { number: 0, parent: 0, title: "", text: "", assignee: "", example: "", prior: "", ...request } })
}

test("a new issue whose save was lost comes back after a reload, and Retry saves it once", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  const title = label + " issue"
  await open(page, origin, "issues=1")
  await expect(page.getByRole("heading", { name: "Issues", exact: true })).toBeVisible()
  await page.request.post(origin + "/__fault?writes=1")
  await page.getByRole("button", { name: "New issue", exact: true }).click()
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(title)
  await page.getByRole("textbox", { name: "Summary", exact: true }).fill("Body")
  await page.locator(".sui-issue-form-actions").getByRole("button", { name: "New issue", exact: true }).click()
  await expect(page.locator(".sui-issue-form-error")).toContainText("Couldn't save. Retry.")
  await expect(page).toHaveURL(/[?&]resume-op=new&resume-key=[^&]+$/)

  await page.reload()
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(title)
  await expect(page.getByRole("textbox", { name: "Summary", exact: true })).toHaveValue("Body")
  await expect(page.locator(".sui-issue-form-error")).toContainText("Couldn't save. Retry.")
  await page.screenshot({ path: info.outputPath("recovered-new.png"), fullPage: true })
  await page.locator(".sui-issue-form-error").getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page).toHaveURL(origin + "/?issues=1")
  await expect(page.locator(".sui-issue-form-error")).toHaveCount(0)
  const listed = await (await page.request.get(origin + "/api/issues")).json() as { items: Array<{ title: string }> }
  expect(listed.items.filter(item => item.title === title)).toHaveLength(1)
})

test("a comment that finished while the page was away opens its issue and leaves the resume address", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  const key = `away-${info.project.name}-${Date.now()}`
  const text = "Thanks"
  expect((await write(page, origin, { op: "comment", key, number: 124, text })).status()).toBe(200)
  await open(page, origin, `issues=1&resume-op=comment&resume-key=${key}`)
  await expect(page).toHaveURL(origin + "/?issues=1")
  await expect(page.locator(".sui-item-conv-comments").getByText(text, { exact: true })).toBeVisible()
  await expect(page.locator(".sui-issue-form-error")).toHaveCount(0)
})

test("a refused comment comes back as its issue with no retry", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  const key = `refused-${info.project.name}-${Date.now()}`
  const refused = await write(page, origin, { op: "comment", key, number: 124, text: "  " })
  expect(await refused.json()).toEqual({ reason: "empty", unwritten: true })
  await open(page, origin, `issues=1&resume-op=comment&resume-key=${key}`)
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toBeVisible()
  await expect(page.locator(".sui-issue-form-error")).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Issues pane" }).getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
})

test("a VIP whose save was lost reopens at its review step with Retry", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  const key = label + "-4"
  const title = label + " tuples"
  await page.request.post(origin + "/__fault?writes=1")
  const lost = await write(page, origin, { op: "propose", key, title, text: "Add tuples.", example: "const t = [1, 2]", prior: "Rust" })
  expect(lost.status()).not.toBe(200)
  await open(page, origin, `issues=1&resume-op=propose&resume-key=${key}`)
  await expect(page.getByRole("heading", { name: "Propose a VIP" })).toBeVisible()
  await expect(page.locator(".sui-card").filter({ hasText: title })).toContainText("Add tuples.")
  await expect(page.locator(".sui-issue-form-error")).toContainText("Couldn't save. Retry.")
  await expect(page.getByRole("button", { name: "Submit VIP", exact: true })).toBeDisabled()
  await page.locator(".sui-issue-form-error").getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page).toHaveURL(origin + "/?issues=1")
  await expect(page.locator(".sui-item-conv-header")).toContainText("VIP · In review")
})

test("a deployment without sign-in says so when Sign in is pressed", async ({ page }, info) => {
  const origin = origins[info.project.name]!
  await page.request.post(origin + "/__fault?writes=0&session=unavailable")
  await open(page, origin, "")
  const signIn = page.getByRole("button", { name: "Sign in", exact: true })
  await signIn.click()
  await expect(page.getByRole("alert").getByText("Sign-in unavailable.")).toBeVisible()
  await expect(signIn).toBeEnabled()
})
