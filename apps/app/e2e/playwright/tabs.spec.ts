import { expect, test } from "@playwright/test"
import type { Page, Request, WebSocketRoute } from "@playwright/test"
import { prepareHealthPage } from "./healthFixture"

/*
 * Lane L2 (docs/LOCAL-APP.md "Tabs", "Cards"): sessions over the keyboard
 * (Cmd+T / Cmd+W / Cmd+1..9), the composer's `+` menu, the terminal over the
 * PTY topics, card tabs, and the dock — the chrome icons pinned bottom-left.
 *
 * The server is a double: every HTTP seam the chrome touches answers through
 * page.route, and `/ws` through page.routeWebSocket, so the spec proves the
 * SPA's side of the contract and keeps passing unchanged once the real
 * `bun src/bun/serve.ts` stands behind the same paths.
 */

const HARNESSES = [
  {
    id: "claude",
    displayName: "Claude Code",
    binary: "/opt/homebrew/bin/claude",
    version: "2.1.0",
    status: "signed-in",
    account: { email: "will@codeplane.app" },
    launch: { argv: ["claude"] }
  },
  {
    id: "codex",
    displayName: "Codex",
    binary: "/opt/homebrew/bin/codex",
    version: "0.50.0",
    status: "api-key",
    account: { label: "OPENAI_API_KEY" },
    launch: { argv: ["codex"] }
  },
  {
    id: "gemini",
    displayName: "Gemini",
    binary: null,
    version: null,
    status: "unavailable",
    account: null,
    launch: { argv: ["gemini"] }
  }
]


const SESSION_ID = "pty-1"

interface ServerDouble {
  /** Every `POST /api/pty` body, in order. */
  readonly created: Array<Record<string, unknown>>
  /** Every `DELETE /api/pty/:id` id, in order. */
  readonly deleted: Array<string>
  /** Every `pty.input` frame's data, concatenated in arrival order. */
  readonly typed: () => string
  /** The `/ws` routes that opened. */
  readonly sockets: Array<WebSocketRoute>
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body)
})

/** Install the server double. `repos` is what `GET /api/repos` answers. */
const serve = async (page: Page, repos: ReadonlyArray<unknown> = []): Promise<ServerDouble> => {
  const created: Array<Record<string, unknown>> = []
  const deleted: Array<string> = []
  const inputs: Array<string> = []
  const sockets: Array<WebSocketRoute> = []

  // The last route registered wins, so the catch-all goes first: every seam
  // the chrome does not mock answers as absent, never as the SPA's own HTML.
  await page.route("**/api/**", (route) => route.fulfill(json({ error: { code: "absent", message: "no seam" } }, 404)))
  await page.route("**/api/bootstrap", (route) => route.fulfill(json({
    apiVersion: 1,
    host: "local",
    version: "test",
    buildSha: "test",
    capabilities: ["agent", "identity", "local.repositories", "local.targets", "local.terminal", "local.harnesses"],
    authFlow: "both",
    sandbox: { platform: "darwin", mode: "trusted-only" }
  })))
  await page.route("**/api/harnesses", (route) => route.fulfill(json({ harnesses: HARNESSES })))
  await page.route("**/api/repos", (route) => route.fulfill(json({ repos })))
  await page.route("**/api/pty", (route) => {
    if (route.request().method() !== "POST") return route.fulfill(json({ sessions: [] }))
    created.push(route.request().postDataJSON() as Record<string, unknown>)
    return route.fulfill(json({ sessionId: SESSION_ID }))
  })
  await page.route(`**/api/pty/${SESSION_ID}/resize`, (route) => route.fulfill(json({ ok: true })))
  await page.route(`**/api/pty/${SESSION_ID}`, (route) => {
    if (route.request().method() === "DELETE") deleted.push(SESSION_ID)
    return route.fulfill(json({ ok: true }))
  })
  await page.routeWebSocket("**/ws", (socket) => {
    sockets.push(socket)
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { type: string; topic?: string; sessionId?: string; data?: string }
      if (frame.type === "subscribe" && frame.topic === `pty:${SESSION_ID}`) {
        socket.send(JSON.stringify({ type: "subscribed", topic: frame.topic }))
        socket.send(JSON.stringify({ type: "pty.output", sessionId: SESSION_ID, data: "hello from pty\r\n" }))
      }
      if (frame.type === "pty.input" && frame.sessionId === SESSION_ID) inputs.push(frame.data ?? "")
    })
  })
  return { created, deleted, typed: () => inputs.join(""), sockets }
}

const isPtyCreate = (request: Request): boolean => request.method() === "POST" && /\/api\/pty$/.test(request.url())

/** Open a terminal tab through the dock's `+` menu and wait for its emulator; the tab id is the session id. */
const openTerminal = async (page: Page): Promise<string> => {
  const creating = page.waitForRequest(isPtyCreate)
  await page.getByTestId("dock-add").click()
  await page.getByTestId("dock-add-terminal").click()
  await creating
  const tabId = SESSION_ID
  await expect(page.getByTestId(`tab-body-${tabId}`)).toBeVisible()
  await expect(page.getByTestId(`terminal-${SESSION_ID}`)).toBeVisible()
  return tabId
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

test("the app boots with the main tab and the dock alone — no drawer behind the logo", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  // The wordmark is a static mark: no button, nothing to expand.
  await expect(page.getByRole("button", { name: "Smithers", exact: true })).toHaveCount(0)
  await expect(page.locator(".session-sidebar")).toHaveCount(0)
  // The dock pins the chrome at the bottom left: new session, the doors, the theme toggle.
  const dock = page.getByTestId("chrome-actions")
  await expect(dock).toBeVisible()
  await expect(page.getByTestId("dock-add")).toBeVisible()
  await expect(page.locator('[data-flow="appearance.dark-mode"]')).toBeVisible()
  await expect(page.getByTestId("tab-body-main")).toBeVisible()
  await expect(page.getByTestId("transcript")).toBeVisible()
  // The composer stays summoned-only: hidden at boot, opened by the Chat button.
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("chrome-sign-in")).toBeVisible()
})

test("the dock's + menu paints upward: Terminal, then the agents with their accounts", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  await page.getByTestId("dock-add").click()
  const menu = page.getByTestId("dock-add-menu")
  await expect(menu).toBeVisible()
  /*
   * Hit-testing the item's own centre is what a pointer does: the menu must
   * not be clipped by any scrolling ancestor (the old sidebar strip's
   * overflow cut it to nothing while aria-expanded read true).
   */
  const painted = await page.getByTestId("dock-add-terminal").evaluate((item) => {
    const rect = item.getBoundingClientRect()
    return item.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
  })
  expect(painted).toBe(true)
  // One Smithers: no second conversation is offered.
  await expect(page.getByTestId("dock-add-chat")).toHaveCount(0)
  await expect(page.getByTestId("dock-add-terminal")).toHaveText("Terminal")
  await expect(page.getByTestId("dock-add-agents")).toHaveText("Agents")
  // The named roles lead the section: the orchestrator's harness (Claude Code) is signed in here,
  // the explainer's (OpenCode · Kimi) is absent from this double, so its row is disabled with the reason.
  const orchestrator = page.getByTestId("dock-add-role-orchestrator")
  await expect(orchestrator).toContainText("Orchestrator · Fable 5")
  await expect(orchestrator).toBeEnabled()
  const explainer = page.getByTestId("dock-add-role-explainer")
  await expect(explainer).toBeDisabled()
  await expect(explainer).toContainText("not installed")
  const claude = page.getByTestId("dock-add-harness-claude")
  await expect(claude).toContainText("Claude Code")
  await expect(claude).toContainText("will@codeplane.app")
  await expect(claude).toBeEnabled()
  const codex = page.getByTestId("dock-add-harness-codex")
  await expect(codex).toContainText("Codex")
  await expect(codex).toContainText("OPENAI_API_KEY")
  // Unavailable harnesses are listed last, disabled, with their status.
  const gemini = page.getByTestId("dock-add-harness-gemini")
  await expect(gemini).toBeDisabled()
  await expect(gemini).toContainText("unavailable")
  const items = menu.locator("[role=menuitem]")
  await expect(items.first()).toHaveText("Terminal")
  await expect(items.last()).toContainText("unavailable")
})

test("the dock stays visible inside a terminal tab", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  const theme = page.locator('[data-flow="appearance.dark-mode"]')
  await expect(theme).toBeVisible()
  await openTerminal(page)
  // Main is hidden, the terminal shows, and the dock's theme toggle is still on screen.
  await expect(page.getByTestId("tab-body-main")).toBeHidden()
  await expect(page.getByTestId(`tab-body-${SESSION_ID}`)).toBeVisible()
  await expect(theme).toBeVisible()
})

test("an agent from the dock's + runs in its own tab and is a subagent card in the conversation", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  await page.getByTestId("dock-add").click()
  const creating = page.waitForRequest(isPtyCreate)
  await page.getByTestId("dock-add-harness-claude").click()
  await creating
  await expect(page.getByTestId(`tab-body-${SESSION_ID}`)).toBeVisible()
  await expect(page.getByTestId(`terminal-${SESSION_ID}`)).toBeVisible()
  // Back in the conversation (Cmd+1), the launch is a card — embedded, with the way back to the tab.
  await page.keyboard.press("Meta+1")
  const card = page.locator(".smithers-card[data-kind=agent]")
  await expect(card).toBeVisible()
  await expect(card).toContainText("Claude Code is running")
  await page.getByTestId(`agent-open-tab-${SESSION_ID}`).click()
  await expect(page.getByTestId(`tab-body-${SESSION_ID}`)).toBeVisible()
  await expect(page.getByTestId("tab-body-main")).toBeHidden()
})

test("a terminal tab creates a PTY session, renders its output, and sends keystrokes", async ({ page }) => {
  const server = await serve(page)
  await page.goto("/")
  await openTerminal(page)

  expect(server.created).toHaveLength(1)
  expect(server.created[0]).toMatchObject({ kind: "terminal" })
  expect(server.created[0]).not.toHaveProperty("cwd")
  expect(typeof server.created[0]?.cols).toBe("number")
  expect(typeof server.created[0]?.rows).toBe("number")

  // The main tab stays mounted, hidden.
  await expect(page.getByTestId("tab-body-main")).toBeHidden()
  await expect(page.getByTestId("tab-body-main")).toHaveCount(1)

  const terminal = page.getByTestId(`terminal-${SESSION_ID}`)
  await expect(terminal.locator(".xterm-rows")).toContainText("hello from pty")

  await terminal.click()
  await page.keyboard.type("ls")
  await expect.poll(() => server.typed()).toBe("ls")
})

test("Cmd+W asks before closing a live terminal, then deletes its session; main never closes", async ({ page }) => {
  const server = await serve(page)
  await page.goto("/")
  const tabId = await openTerminal(page)

  await page.keyboard.press("Meta+w")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Close session", exact: true }).click()

  await expect(page.getByTestId(`tab-body-${tabId}`)).toHaveCount(0)
  await expect.poll(() => server.deleted).toEqual([SESSION_ID])
  await expect(page.getByTestId("tab-body-main")).toBeVisible()

  // Cmd+W on main: nothing to close, nothing asked.
  await page.keyboard.press("Meta+w")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByTestId("tab-body-main")).toBeVisible()
})

test("Cmd+1 selects the main tab and Cmd+2 the terminal Cmd+T opened", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  const tabId = await openTerminal(page)

  await page.keyboard.press("Meta+1")
  await expect(page.getByTestId("tab-body-main")).toBeVisible()
  await expect(page.getByTestId(`tab-body-${tabId}`)).toBeHidden()

  await page.keyboard.press("Meta+2")
  await expect(page.getByTestId(`tab-body-${tabId}`)).toBeVisible()
  await expect(page.getByTestId("tab-body-main")).toBeHidden()
})

test("a maximized card offers Open in tab; closing the tab keeps the card", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  // /appearance.theme opens the color-theme picker card with no backend at all.
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  const composer = page.getByTestId("composer-input")
  await composer.click()
  await composer.fill("/appearance.theme")
  await composer.press("Enter")
  await page.keyboard.press("Escape")
  const transcript = page.getByTestId("transcript")
  const card = transcript.getByTestId("card-theme-picker")
  await expect(card).toBeVisible()

  // Embedded: no tab affordance. Maximized: the affordance appears.
  await expect(page.getByTestId("card-open-in-tab-theme-picker")).toHaveCount(0)
  await card.getByTestId("card-maximize-theme-picker").click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await page.getByTestId("card-open-in-tab-theme-picker").click()

  const tabId = "card-theme-picker"
  const body = page.getByTestId(`tab-body-${tabId}`)
  await expect(body).toBeVisible()
  await expect(body.getByTestId("card-theme-picker")).toBeVisible()
  await expect(body.getByTestId("card-theme-picker")).toHaveAttribute("data-maximized", "false")

  // Closing a card tab keeps the card in the transcript.
  await page.keyboard.press("Meta+w")
  await expect(page.getByTestId(`tab-body-${tabId}`)).toHaveCount(0)
  await expect(page.getByTestId("tab-body-main")).toBeVisible()
  await expect(transcript.getByTestId("card-theme-picker")).toBeVisible()
})

test("health: a launched agent and its terminal share semantic status, expire offline and preserve unknown exit", async ({ page }) => {
  const server = await serve(page)
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  await page.goto("/")
  await prepareHealthPage(page)
  await page.getByTestId("dock-add").click()
  const creating = page.waitForRequest(isPtyCreate)
  await page.getByTestId("dock-add-harness-claude").click()
  await creating
  await expect(page.getByTestId(`terminal-${SESSION_ID}`)).toBeVisible()
  await expect.poll(() => server.sockets.length).toBeGreaterThan(0)
  const status = { subjectId: `session:${SESSION_ID}`, state: "running", activity: "working", health: "healthy", attention: "none",
    freshness: "fresh", updatedAt: now, provenance: { checkerId: "fixture.semantic", monitorId: "host", observedAt: now,
      expiresAt: now + 120_000, evidenceSeq: 1, incarnation: "opaque-owner", version: 1 } }
  for (const socket of server.sockets) socket.send(JSON.stringify({ type: "pty.status", sessionId: SESSION_ID, status }))
  // The agent card in the conversation carries the status.
  await page.keyboard.press("Meta+1")
  const card = page.locator(".smithers-card[data-kind=agent]")
  await expect(card.getByTestId("status-details")).toHaveText("Running · Working")
  // The way back to the agent is the card's own button.
  await page.getByTestId(`agent-open-tab-${SESSION_ID}`).click()
  await expect(page.getByTestId(`tab-body-${SESSION_ID}`)).toBeVisible()
  await page.keyboard.press("Meta+1")
  await page.clock.fastForward(120_001)
  await expect(card.getByTestId("status-details")).toHaveText("Running · Stale")
  for (const socket of server.sockets) socket.send(JSON.stringify({ type: "pty.exit", sessionId: SESSION_ID, code: null }))
  await expect(card.getByTestId("status-details")).toHaveText("Exited · Outcome unknown")
  expect(server.created).toHaveLength(1)
  expect(server.deleted).toHaveLength(0)
})
