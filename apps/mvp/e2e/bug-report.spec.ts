import type { APIRequestContext } from "@playwright/test"
import { BUG_REPORTS_ROUTE } from "../src/features/bugs/contract"
import type { BugReport } from "../src/features/bugs/schema"
import { expect, test } from "./devices"
import { baseURL, me, onThisMachine, partly, requires, target } from "./target"

// Bug reports, end to end (docs/features/bugs.md): the real app, its engine worker, the bug plugin, ChatApi, Postgres
// and Electric. The person types `/bug`, writes what happened in the form and sends it; the report is Sent once its
// row comes back from Postgres through sync, and their inbox lists it. An Admin then reads it with what the tab showed
// and never a word of the conversation's chat: locally as local development's Admin, in a deployment through the read
// route with the deployment's read token (E2E_BUG_READ_TOKEN). No model is called. Runs against a deployment as the
// test account, a Member.
requires("member")

/** Typing a person can follow in the video. */
const typing = { delay: 40 }

/** The report whose words are `words`, read as an Admin: the session locally, the read token in a deployment. */
const readAsAdmin = async (request: APIRequestContext, words: string): Promise<BugReport | undefined> => {
  const response = await request.get(`${BUG_REPORTS_ROUTE}?limit=200`)
  expect(response.status()).toBe(200)
  const { reports } = await response.json() as { readonly reports: ReadonlyArray<BugReport> }
  return reports.find((report) => report.what === words)
}

test("bug report: /bug opens the form, Send files it with the page and the tab's runs, and no chat reaches the report", {
  annotation: { type: "summary", description: "/bug, a sentence and Send: the report lands with its page and ids, never the chat." },
}, async ({ devices, playwright }) => {
  test.setTimeout(120_000)
  const [a] = await devices.open("A")
  const page = a.page
  const words = `The run page stayed blank after Retry ${devices.word}`
  // Where the person was, and what the conversation says there: the report names the page and none of its chat.
  const from = new URL(page.url()).pathname
  const chat = (await page.locator(".sui-chat-messages .sui-chat-message").allTextContents())
    .map((text) => text.trim())
    .filter((text) => text.length >= 12)

  await test.step("Type /bug", async () => {
    await a.openComposer()
    await a.composer.pressSequentially("/bug", typing)
    await expect(a.composer).toHaveValue("/bug")
    await expect(page.getByRole("option").first().locator(".sui-completion-label")).toHaveText("/bug")
    await a.composer.press("Enter")
    await expect(page).toHaveURL(/\/app\/bugs\/report$/)
  })

  await test.step("Write what happened and send it", async () => {
    const field = page.getByRole("textbox", { name: "What happened?" })
    await expect(field).toBeFocused()
    await field.pressSequentially(words, typing)
    await page.getByRole("button", { name: "Send" }).click()
    const status = page.getByRole("form", { name: "Report a bug" }).getByRole("status")
    await expect(status).toContainText("Sent", { timeout: 30_000 })
    const github = new URL((await status.getByRole("link", { name: "Open on GitHub" }).getAttribute("href"))!)
    expect(`${github.origin}${github.pathname}`).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/new$/)
    expect(github.searchParams.get("title")).toBe(words)
    await expect(field).toHaveValue("")
  })

  await test.step("The person's inbox lists it", async () => {
    await page.goto("/app/bugs")
    const entry = page.getByRole("listitem").filter({ hasText: words })
    await expect(entry).toBeVisible({ timeout: 30_000 })
    await entry.getByText(words).first().click()
    await expect(entry.getByText(from).first()).toBeVisible()
    const shown = await entry.textContent()
    for (const text of chat) expect(shown, "a chat message in the report").not.toContain(text)
  })

  if (partly("bugReader")) {
    await test.step("An Admin reads it, with the page and the tab's runs and no chat", async () => {
      const request = target === "local"
        ? page.request
        : await playwright.request.newContext({
          baseURL,
          ignoreHTTPSErrors: onThisMachine(baseURL),
          storageState: { cookies: [], origins: [] },
          extraHTTPHeaders: { authorization: `Bearer ${process.env.E2E_BUG_READ_TOKEN}` },
        })
      let report: BugReport | undefined
      await expect.poll(async () => (report = await readAsAdmin(request, words)) !== undefined, { timeout: 30_000 }).toBe(true)
      expect(report).toMatchObject({
        what: words,
        route: from,
        reporterLogin: me().login,
        reporterRole: me().role,
        actedBy: "flow",
      })
      const version = await page.request.get("/version.json")
      expect(version.ok()).toBe(true)
      expect(report!.build).toBe((await version.json() as { build: string }).build)
      expect(report!.build).not.toBe("unknown")
      expect(report!.runs.length).toBeGreaterThan(0)
      expect(report!.traces.every((trace) => /^[0-9a-f]{32}$/.test(trace))).toBe(true)
      expect(report!.browser).toContain("Mozilla")
      expect(report!.viewport).toMatch(/^\d+x\d+$/)
      // What went wrong in the tab, by record name and code from its own observability (src/flows/errors.ts).
      expect(Array.isArray(report!.errors)).toBe(true)
      expect(report!.errors.every((error) => error.code === null || /^[\w./:-]{1,64}$/.test(error.code))).toBe(true)
      const stored = JSON.stringify(report)
      for (const text of chat) expect(stored, "a chat message in the stored report").not.toContain(text)
    })
  }
})
