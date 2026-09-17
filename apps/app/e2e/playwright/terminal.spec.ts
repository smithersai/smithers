import { expect, test } from "@playwright/test"
import type { Page, Response } from "@playwright/test"
import { localApiDelete, localApiGet } from "./localApi"
import { prepareHealthPage } from "./healthFixture"

/*
 * Lane L4 (docs/LOCAL-APP.md "Tabs", `/api/pty*`, the `pty:<id>` topics)
 * against the real local origin: Cmd+T opens a terminal tab whose
 * PTY session is a login shell under the terminal sandbox policy, typed
 * text reaches the shell over `/ws`, its output renders in the emulator,
 * the session is listed alive, and closing the tab deletes it.
 */

const isPtyCreate = (response: Response): boolean =>
  response.request().method() === "POST" && /\/api\/pty$/.test(response.url())
const openedSessionIds = new Set<string>()

/** Open a terminal tab through the dock's `+` menu; the tab id is the session id the server minted. */
const openTerminal = async (page: Page): Promise<string> => {
  const creating = page.waitForResponse(isPtyCreate)
  await page.getByTestId("dock-add").click()
  await page.getByTestId("dock-add-terminal").click()
  const response = await creating
  expect(response.status()).toBe(201)
  const { sessionId } = (await response.json()) as { sessionId: string }
  openedSessionIds.add(sessionId)
  expect(sessionId).toMatch(/^pty-/)
  await expect(page.getByTestId(`tab-body-${sessionId}`)).toBeVisible()
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

  // Close with Cmd+W: the shell is alive, so the app asks first.
  await page.keyboard.press("Meta+w")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Close session", exact: true }).click()
  await expect(page.getByTestId(`tab-body-${sessionId}`)).toHaveCount(0)
  await expect(page.getByTestId("tab-body-main")).toBeVisible()
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
  await page.keyboard.press("Meta+w")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByTestId(`tab-body-${sessionId}`)).toHaveCount(0)
  await expect
    .poll(async () => ((await (await localApiGet(page, request, "/api/pty")).json()) as { sessions: Array<unknown> }).sessions.length)
    .toBe(0)
  openedSessionIds.delete(sessionId)
})

test("health: a real shell's explicit semantic markers reach the persisted terminal status through the Effect monitor", async ({ page, request }) => {
  test.skip(process.env.SMITHERS_E2E_HEALTH !== "1", "Opt in to the test host's explicit semantic fixture")
  await page.goto("/")
  await prepareHealthPage(page)
  const sessionId = await openTerminal(page)
  const terminal = page.getByTestId(`terminal-${sessionId}`)
  for (const [activity] of [["working"], ["idle"], ["needs-input"]] as const) {
    await terminal.click()
    // The echoed printf command is not a complete record. Only its actual output matches.
    await page.keyboard.type(`${activity === "needs-input" ? "sleep 1; " : ""}printf 'SMITHERS_TEST_HEALTH:%s\\n' ${activity}`)
    await page.keyboard.press("Enter")
    if (activity === "needs-input") {
      await page.keyboard.press("Meta+1")
      await expect(terminal).toBeHidden()
    }
    await expect
      .poll(async () => {
        const { sessions } = (await (await localApiGet(page, request, "/api/pty")).json()) as { sessions: Array<{ sessionId: string; status?: { activity?: string } }> }
        return sessions.find((session) => session.sessionId === sessionId)?.status?.activity
      }, { timeout: 10_000 })
      .toBe(activity)
  }
  const snapshot = await localApiGet(page, request, "/api/pty")
  const body = await snapshot.json()
  expect(body.sessions.find((session: { sessionId: string }) => session.sessionId === sessionId).status)
    .toMatchObject({ subjectId: `session:${sessionId}`, activity: "needs-input", attention: "needs-input",
      provenance: { checkerId: "fixture.semantic" } })
  await page.keyboard.press("Meta+2")
  await expect(terminal).toBeVisible()
  await terminal.click()
  await page.keyboard.type("exit 7")
  await page.keyboard.press("Enter")
  await expect(terminal.locator(".xterm-rows")).toContainText("process exited (7)", { timeout: 10_000 })
})
