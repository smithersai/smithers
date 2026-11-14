// Stays .ts: Playwright collects browser tests by JS/TS extension only.
// Links and addresses the page reads but does not act on: a draft link the person may no longer use, a history entry
// outside the app's routes, and a recovery address in mock mode.
import { expect, test } from "./coverage"

const port = Number(process.env.E2E_PORT ?? 4173)
const wiki = (page: import("./coverage").Page) => page.getByRole("region", { name: "Wiki", exact: true })

test("a chat draft link opens no editor for a person who may not draft", async ({ page }) => {
  await page.goto("/?agent=mock")
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await expect(page.locator(".vl-nav-role")).toHaveText("Contributor")
  await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
  const ask = page.getByRole("dialog", { name: "Ask the agent" })
  await ask.getByRole("textbox", { name: "Message" }).fill("Draft a wiki edit for the roadmap: add the wiki-edit brick")
  await ask.getByRole("button", { name: "Send", exact: true }).click()
  const review = page.getByRole("link", { name: "Review it", exact: true })
  await expect(review).toBeVisible()
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("new")
  await expect(page.locator(".vl-nav-role")).toHaveText("New")
  await review.click()
  await expect(wiki(page).getByRole("textbox", { name: "Edit Roadmap" })).toHaveCount(0)
})

test("Back to an address outside the wiki leaves the wiki open", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${port}/e2e/runtime/index.html`)
  await page.getByRole("button", { name: "Wiki", exact: true }).click()
  await expect(wiki(page).getByRole("heading", { name: "VibeLang factory wiki" })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/e2e\/runtime\/index\.html$/)
  await expect(wiki(page).getByRole("heading", { name: "VibeLang factory wiki" })).toBeVisible()
})

test("a recovery address in mock mode opens the issue list", async ({ page }) => {
  await page.goto("/?agent=mock&issues=1&resume-recovery=r1&resume-op=comment&resume-key=k1")
  await expect(page.getByRole("link", { name: "Case branches on tuples", exact: true })).toBeVisible()
})
