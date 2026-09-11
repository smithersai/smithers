import { expect, test } from "@playwright/test"
import type { Page, Request, WebSocketRoute } from "@playwright/test"

/*
 * Lane L2 (docs/LOCAL-APP.md "Tabs", "Cards"): the strip, the `+` menu, the
 * terminal over the PTY topics, card tabs, and the keyboard bindings.
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

const FORCE_REPO = {
  id: "force",
  path: "/Users/williamcory/artsy/force",
  name: "artsy/force",
  git: { branch: "main", remote: "git@github.com:artsy/force.git" },
  warnings: [],
  smithers: {
    detected: true,
    workspaceFile: "WORKSPACE.ts",
    declarationFiles: ["WORKSPACE.ts"],
    reason: "ok",
    workspaces: [{ path: ".", title: "artsy/force" }]
  }
}

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

/** Open a terminal tab through the `+` menu and wait for its emulator; the tab id is the session id. */
const openTerminal = async (page: Page): Promise<string> => {
  const creating = page.waitForRequest(isPtyCreate)
  await page.getByTestId("tab-add").click()
  await page.getByTestId("tab-add-terminal").click()
  await creating
  const tabId = SESSION_ID
  await expect(page.getByTestId(`tab-${tabId}`)).toHaveAttribute("data-active", "true")
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

test("the strip boots with the main tab and the + button alone", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  const strip = page.getByTestId("tab-strip")
  await expect(strip).toBeVisible()
  await expect(page.getByTestId("workspace-heading")).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId("tab-add")).toBeVisible()
  await expect(strip.locator(".tab")).toHaveCount(0)
  // The heading is the workspace, not a closable row.
  await expect(page.getByTestId("tab-close-main")).toHaveCount(0)
  await expect(page.getByTestId("tab-body-main")).toBeVisible()
  await expect(page.getByTestId("transcript")).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  // No repository: no origin chip; the selector reads "Select a repo" and opens the local picker entry.
  await expect(page.getByTestId("repo-chip")).toHaveCount(0)
  await expect(page.getByTestId("composer-repo-trigger")).toHaveText("Select a repo")
  await page.getByTestId("composer-repo-trigger").click()
  await expect(page.getByTestId("chrome-open-repo")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("chrome-sign-in")).toBeVisible()
})

test("the sidebar pins the open repository as the active row and nests a new terminal under it", async ({ page }) => {
  await serve(page, [FORCE_REPO])
  await page.goto("/")
  const section = page.getByTestId("repo-section")
  await expect(section).toBeVisible()
  await expect(page.getByTestId("repo-empty")).toHaveCount(0)
  const row = section.locator(".repo-group[data-active=\"true\"]")
  await expect(row).toHaveCount(1)
  await expect(row.locator(".repo-name")).toHaveText("artsy/force")
  // The workspace heading stays first, above the repositories.
  const [main, repo] = await Promise.all([page.getByTestId("workspace-heading").boundingBox(), row.boundingBox()])
  expect((repo?.y ?? 0) > (main?.y ?? 0)).toBe(true)
  await openTerminal(page)
  // The terminal nests under its repository, indented to its right.
  await expect(row.locator(`.repo-tabs [data-testid=tab-${SESSION_ID}]`)).toBeVisible()
  const tab = await page.getByTestId(`tab-${SESSION_ID}`).boundingBox()
  expect((tab?.x ?? 0) > (repo?.x ?? 0)).toBe(true)
  await expect(page.getByTestId("repo-none")).toHaveCount(0)
})

test("the composer header names the active repository and its local path", async ({ page }) => {
  await serve(page, [FORCE_REPO])
  await page.goto("/")
  await expect(page.getByTestId("composer-repo-trigger")).toHaveText("artsy/force")
  await expect(page.getByTestId("repo-chip")).toContainText("artsy/force")
  await expect(page.getByTestId("repo-chip")).toHaveAttribute("title", FORCE_REPO.path)
  await expect(page.getByTestId("repo-chip")).toHaveAttribute("data-origin", "local")
})

test("the + menu paints beside the sidebar: Terminal, then the agents with their accounts", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  await page.getByTestId("tab-add").click()
  const menu = page.getByTestId("tab-add-menu")
  await expect(menu).toBeVisible()
  /*
   * Regression: the menu used to live inside the scrolling strip, whose
   * overflow clipped it to 28px — `toBeVisible` still passed (a box exists)
   * and `click()` still landed (Playwright scrolls the clipped strip to the
   * item, which a human never does). Hit-testing the item's own centre is
   * what a pointer does, so that is the pin.
   */
  const painted = await page.getByTestId("tab-add-terminal").evaluate((item) => {
    const rect = item.getBoundingClientRect()
    return item.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
  })
  expect(painted).toBe(true)
  // One Smithers: no second conversation is offered.
  await expect(page.getByTestId("tab-add-chat")).toHaveCount(0)
  await expect(page.getByTestId("tab-add-terminal")).toHaveText("Terminal")
  await expect(page.getByTestId("tab-add-agents")).toHaveText("Agents")
  // The named roles lead the section: the orchestrator's harness (Claude Code) is signed in here,
  // the explainer's (OpenCode · Kimi) is absent from this double, so its row is disabled with the reason.
  const orchestrator = page.getByTestId("tab-add-role-orchestrator")
  await expect(orchestrator).toContainText("Orchestrator · Fable 5")
  await expect(orchestrator).toBeEnabled()
  const explainer = page.getByTestId("tab-add-role-explainer")
  await expect(explainer).toBeDisabled()
  await expect(explainer).toContainText("not installed")
  const claude = page.getByTestId("tab-add-harness-claude")
  await expect(claude).toContainText("Claude Code")
  await expect(claude).toContainText("will@codeplane.app")
  await expect(claude).toBeEnabled()
  const codex = page.getByTestId("tab-add-harness-codex")
  await expect(codex).toContainText("Codex")
  await expect(codex).toContainText("OPENAI_API_KEY")
  // Unavailable harnesses are listed last, disabled, with their status.
  const gemini = page.getByTestId("tab-add-harness-gemini")
  await expect(gemini).toBeDisabled()
  await expect(gemini).toContainText("unavailable")
  const items = menu.locator("[role=menuitem]")
  await expect(items.first()).toHaveText("Terminal")
  await expect(items.last()).toHaveText("New agent…")
  await expect(page.getByTestId("tab-add-new-agent")).toBeEnabled()
})

test("the sidebar is vertical and its chrome stays visible inside a terminal tab", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  const strip = page.getByTestId("tab-strip")
  await expect(strip).toHaveAttribute("aria-orientation", "vertical")
  const theme = page.locator('[data-flow="appearance.dark-mode"]')
  await expect(theme).toBeVisible()
  await openTerminal(page)
  // Main is hidden, the terminal shows, and the sidebar's theme toggle is still on screen.
  await expect(page.getByTestId("tab-body-main")).toBeHidden()
  await expect(theme).toBeVisible()
  const [main, terminal] = await Promise.all([
    page.getByTestId("workspace-heading").boundingBox(),
    page.getByTestId(`tab-${SESSION_ID}`).boundingBox()
  ])
  // Stacked: the terminal tab sits BELOW main, nested (indented) under its repository row.
  expect((terminal?.y ?? 0) > (main?.y ?? 0)).toBe(true)
  expect((terminal?.x ?? 0) > (main?.x ?? 0)).toBe(true)
})

test("an agent from + runs in its own tab and is a subagent card in the conversation", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  await page.getByTestId("tab-add").click()
  const creating = page.waitForRequest(isPtyCreate)
  await page.getByTestId("tab-add-harness-claude").click()
  await creating
  await expect(page.getByTestId(`tab-${SESSION_ID}`)).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId(`terminal-${SESSION_ID}`)).toBeVisible()
  // Back in the conversation, the launch is a card — embedded, with the way back to the tab.
  await page.getByTestId("workspace-name").click()
  const card = page.locator(".smithers-card[data-kind=agent]")
  await expect(card).toBeVisible()
  await expect(card).toContainText("Claude Code is running")
  await page.getByTestId(`agent-open-tab-${SESSION_ID}`).click()
  await expect(page.getByTestId(`tab-${SESSION_ID}`)).toHaveAttribute("data-active", "true")
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

  await expect(page.getByTestId(`tab-${tabId}`)).toHaveCount(0)
  await expect.poll(() => server.deleted).toEqual([SESSION_ID])
  await expect(page.getByTestId("workspace-heading")).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId("tab-body-main")).toBeVisible()

  // Cmd+W on main: nothing to close, nothing asked.
  await page.keyboard.press("Meta+w")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByTestId("workspace-heading")).toBeVisible()
  await expect(page.getByTestId("tab-strip").locator(".tab")).toHaveCount(0)
})

test("Cmd+1 selects the main tab and Cmd+T opens a terminal", async ({ page }) => {
  await serve(page)
  await page.goto("/")
  const tabId = await openTerminal(page)

  await page.keyboard.press("Meta+1")
  await expect(page.getByTestId("workspace-heading")).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId("tab-body-main")).toBeVisible()
  await expect(page.getByTestId(`tab-body-${tabId}`)).toBeHidden()

  await page.keyboard.press("Meta+2")
  await expect(page.getByTestId(`tab-${tabId}`)).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId(`tab-body-${tabId}`)).toBeVisible()
})

test("a maximized card offers Open in tab; closing the tab keeps the card", async ({ page }) => {
  await serve(page)
  await page.goto("/")

  // /appearance.theme opens the color-theme picker card with no backend at all.
  const composer = page.getByTestId("composer-input")
  await composer.click()
  await composer.fill("/appearance.theme")
  await composer.press("Enter")
  const transcript = page.getByTestId("transcript")
  const card = transcript.getByTestId("card-theme-picker")
  await expect(card).toBeVisible()
  await expect(card.getByTestId("card-kind-theme-picker")).toBeVisible()

  // Embedded: no tab affordance. Maximized: the affordance appears.
  await expect(page.getByTestId("card-open-in-tab-theme-picker")).toHaveCount(0)
  await card.getByTestId("card-maximize-theme-picker").click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await page.getByTestId("card-open-in-tab-theme-picker").click()

  const tabId = "card-theme-picker"
  await expect(page.getByTestId(`tab-${tabId}`)).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId(`tab-${tabId}`)).toContainText("Color themes")
  const body = page.getByTestId(`tab-body-${tabId}`)
  await expect(body).toBeVisible()
  await expect(body.getByTestId("card-theme-picker")).toBeVisible()
  await expect(body.getByTestId("card-theme-picker")).toHaveAttribute("data-maximized", "false")

  // Closing a card tab keeps the card in the transcript.
  await page.getByTestId(`tab-close-${tabId}`).click()
  await expect(page.getByTestId(`tab-${tabId}`)).toHaveCount(0)
  await expect(page.getByTestId("workspace-heading")).toHaveAttribute("data-active", "true")
  await expect(transcript.getByTestId("card-theme-picker")).toBeVisible()
})
