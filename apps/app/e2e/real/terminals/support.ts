import type { APIRequestContext, Page, Response, TestInfo } from "@playwright/test"
import { closeComposer, command, expect, realApi, registerOwnedRepo, type OwnedLocalRepo } from "../support/test"

export interface RealPtySession {
  readonly sessionId: string
  readonly kind: "terminal" | "harness"
  readonly cwd: string
  readonly pid: number
  readonly alive: boolean
  readonly exitCode?: number | null
}

const ownedSessions = new Set<string>()

export const bootWorkbench = async (page: Page): Promise<void> => {
  await page.goto("/smithersai/smithers", { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect(page.getByTestId("transcript")).toBeVisible()
}

export const openOwnedRepo = async (
  page: Page,
  repo: OwnedLocalRepo
): Promise<string> => {
  const opening = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/open")
  await command(page, `/repo.open ${repo.path}`)
  const response = await opening
  expect(response.status()).toBe(200)
  let opened: { readonly id: string; readonly path?: string } | undefined
  await expect.poll(async () => {
    const listed = await realApi(page, page.context().request, "GET", "/api/repos")
    if (!listed.ok()) return listed.status()
    const body = await listed.json() as { readonly repos?: ReadonlyArray<{ readonly id: string; readonly path?: string }> }
    opened = body.repos?.find((candidate) => candidate.path === repo.path)
    return opened?.path
  }, { message: `slash-opened repository ${repo.path} appears in the real host inventory` }).toBe(repo.path)
  expect(opened).toBeDefined()
  const repoId = opened!.id
  registerOwnedRepo({ id: repoId, path: repo.path })
  await closeComposer(page)
  return repoId
}

const isPtyCreate = (response: Response): boolean =>
  response.request().method() === "POST" && new URL(response.url()).pathname === "/api/pty"

const ownCreatedSession = async (
  page: Page,
  response: Response,
  previousIds: ReadonlySet<string>
): Promise<string> => {
  expect(response.status()).toBe(201)
  let sessionId: string | undefined
  await expect.poll(async () => {
    const sessions = await listPtys(page, page.context().request)
    sessionId = sessions.find((session) => !previousIds.has(session.sessionId))?.sessionId
    return sessionId
  }, { message: "the UI-created PTY appears in the real host inventory" }).toMatch(/^pty-[0-9a-f]{32}$/)
  expect(sessionId).toBeDefined()
  const createdId = sessionId!
  ownedSessions.add(createdId)
  await expect(page.getByTestId(`terminal-${createdId}`)).toBeVisible()
  await expect(page.getByTestId(`terminal-${createdId}`).locator(".xterm-helper-textarea")).toBeAttached()
  return createdId
}

export const openTerminalThroughSlash = async (page: Page, cwd?: string): Promise<string> => {
  const previousIds = new Set((await listPtys(page, page.context().request)).map((session) => session.sessionId))
  const creating = page.waitForResponse(isPtyCreate)
  await command(page, `/tab.terminal${cwd === undefined ? "" : ` ${cwd}`}`)
  const response = await creating
  await closeComposer(page)
  return ownCreatedSession(page, response, previousIds)
}

export const chooseTerminalFromOpenMenu = async (page: Page): Promise<string> => {
  const previousIds = new Set((await listPtys(page, page.context().request)).map((session) => session.sessionId))
  const creating = page.waitForResponse(isPtyCreate)
  const menu = page.getByTestId("tab-add-menu")
  await expect(menu).toBeVisible()
  await page.getByTestId("tab-add-terminal").click()
  const response = await creating
  const sessionId = await ownCreatedSession(page, response, previousIds)
  return sessionId
}

export const typeTerminalLine = async (page: Page, sessionId: string, line: string): Promise<void> => {
  const terminal = page.getByTestId(`terminal-${sessionId}`)
  await terminal.click()
  await expect(terminal.locator(".xterm-helper-textarea")).toBeFocused()
  await page.keyboard.type(line)
  await page.keyboard.press("Enter")
}

export const listPtys = async (page: Page, request: APIRequestContext): Promise<readonly RealPtySession[]> => {
  const response = await realApi(page, request, "GET", "/api/pty")
  expect(response.status()).toBe(200)
  return ((await response.json()) as { readonly sessions: readonly RealPtySession[] }).sessions
}

export const readPty = async (
  page: Page,
  request: APIRequestContext,
  sessionId: string
): Promise<{ readonly output: string; readonly alive: boolean; readonly truncated: boolean }> => {
  const response = await realApi(page, request, "GET", `/api/pty/${encodeURIComponent(sessionId)}/output`)
  expect(response.status()).toBe(200)
  return response.json()
}

export const forgetOwnedSession = (sessionId: string): void => { ownedSessions.delete(sessionId) }

export const cleanupOwnedSessions = async (page: Page, request: APIRequestContext): Promise<void> => {
  const ids = [...ownedSessions]
  for (const sessionId of ids) {
    const response = await realApi(page, request, "DELETE", `/api/pty/${encodeURIComponent(sessionId)}`)
    if (response.status() !== 200 && response.status() !== 404) {
      throw new Error(`Could not clean up PTY ${sessionId}: HTTP ${response.status()} ${await response.text()}`)
    }
    ownedSessions.delete(sessionId)
  }
  const remaining = await listPtys(page, request)
  const leaked = remaining.filter((session) => ids.includes(session.sessionId))
  expect(leaked, "owned PTY sessions are absent after cleanup").toEqual([])
}

export const attachTerminalEvidence = async (
  testInfo: TestInfo,
  name: string,
  value: unknown
): Promise<void> => {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json"
  })
}

export const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
