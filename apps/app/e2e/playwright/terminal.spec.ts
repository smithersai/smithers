import { expect, test } from "@playwright/test"
import type { Page, Response } from "@playwright/test"
import { localApiDelete, localApiGet } from "./localApi"

/*
 * Lane L4 (docs/LOCAL-APP.md "Tabs", `/api/pty*`, the `pty:<id>` topics)
 * against the real local origin: the `+` menu opens a terminal tab whose
 * PTY session is a login shell under the terminal sandbox policy, typed
 * text reaches the shell over `/ws`, its output renders in the emulator,
 * the session is listed alive, and closing the tab deletes it.
 */

const isPtyCreate = (response: Response): boolean =>
  response.request().method() === "POST" && /\/api\/pty$/.test(response.url())
const openedSessionIds = new Set<string>()

/** Open a terminal tab through the `+` menu; the tab id is the session id the server minted. */
const openTerminal = async (page: Page): Promise<string> => {
  const creating = page.waitForResponse(isPtyCreate)
  await page.getByTestId("tab-add").click()
  await page.getByTestId("tab-add-terminal").click()
  const response = await creating
  expect(response.status()).toBe(201)
  const { sessionId } = (await response.json()) as { sessionId: string }
  openedSessionIds.add(sessionId)
  expect(sessionId).toMatch(/^pty-/)
  await expect(page.getByTestId(`tab-${sessionId}`)).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId(`terminal-${sessionId}`)).toBeVisible()
  return sessionId
}

test.beforeEach(async ({ page }) => {
  // A persisted store from an earlier test must not carry tabs across tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test.afterEach(async ({ page, request }) => {
  for (const sessionId of openedSessionIds) await localApiDelete(page, request, `/api/pty/${sessionId}`)
  openedSessionIds.clear()
})

test("a terminal tab runs a real shell: typed text echoes back, the session is listed, closing deletes it", async ({ page, request }) => {
  await page.goto("/")
  const sessionId = await openTerminal(page)

  const listed = await localApiGet(page, request, "/api/pty")
  expect(listed.status()).toBe(200)
  const { sessions } = (await listed.json()) as { sessions: Array<{ sessionId: string; kind: string; alive: boolean; pid: number }> }
  expect(sessions.map((session) => session.sessionId)).toEqual([sessionId])
  expect(sessions[0]).toMatchObject({ kind: "terminal", alive: true })
  expect(sessions[0]?.pid).toBeGreaterThan(0)

  const terminal = page.getByTestId(`terminal-${sessionId}`)
  await terminal.click()
  await page.keyboard.type("echo hi-from-pty")
  await page.keyboard.press("Enter")
  // The command's own output line, not the echoed keystrokes on the prompt line.
  await expect(terminal.locator(".xterm-rows > div", { hasText: /^hi-from-pty\s*$/ })).toHaveCount(1, { timeout: 10_000 })

  // Close through the strip: the shell is alive, so the app asks first.
  await page.getByTestId(`tab-close-${sessionId}`).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Close session", exact: true }).click()
  await expect(page.getByTestId(`tab-${sessionId}`)).toHaveCount(0)
  await expect(page.getByTestId("workspace-heading")).toHaveAttribute("data-active", "true")
  await expect
    .poll(async () => ((await (await localApiGet(page, request, "/api/pty")).json()) as { sessions: Array<unknown> }).sessions.length, {
      timeout: 10_000
    })
    .toBe(0)
  openedSessionIds.delete(sessionId)
})

test("a shell that exits on its own shows the exit line; closing the tab then asks nothing", async ({ page, request }) => {
  await page.goto("/")
  const sessionId = await openTerminal(page)
  const terminal = page.getByTestId(`terminal-${sessionId}`)
  await terminal.click()
  await page.keyboard.type("exit 3")
  await page.keyboard.press("Enter")
  await expect(terminal.locator(".xterm-rows")).toContainText("process exited (3)", { timeout: 10_000 })
  await expect
    .poll(async () => {
      const { sessions } = (await (await localApiGet(page, request, "/api/pty")).json()) as { sessions: Array<{ sessionId: string; alive: boolean }> }
      return sessions.find((session) => session.sessionId === sessionId)?.alive
    })
    .toBe(false)
  await page.getByTestId(`tab-close-${sessionId}`).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByTestId(`tab-${sessionId}`)).toHaveCount(0)
  await expect
    .poll(async () => ((await (await localApiGet(page, request, "/api/pty")).json()) as { sessions: Array<unknown> }).sessions.length)
    .toBe(0)
  openedSessionIds.delete(sessionId)
})
