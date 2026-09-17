import { scenario } from "./coverage/types"
import { command, createOwnedLocalRepo, expect, test } from "./support/test"
import {
  attachTerminalEvidence,
  bootWorkbench,
  cleanupOwnedSessions,
  forgetOwnedSession,
  listPtys,
  openOwnedRepo,
  openTerminalThroughSlash,
  pidIsAlive,
  readPty,
  typeTerminalLine
} from "./terminals/support"

test.setTimeout(120_000)

test.afterEach(async ({ page, request }) => { await cleanupOwnedSessions(page, request) })

test("a real repository terminal accepts keyboard input and applies a fitted PTY resize", scenario("terminal.input-output-resize", {
  capabilities: ["local.repositories", "local.terminal"],
  description: "Creates a real repository PTY through the slash flow, types into xterm, and proves the fitted geometry inside the child shell.",
  coverage: [
    "action:repo.open", "action:tab.terminal", "host:local", "path:success", "path:keyboard",
    "door:slash", "dimension:keyboard", "dimension:real-pty", "dimension:keyboard-input", "dimension:resize",
    "dimension:repository-cwd", "evidence:pty-api-and-shell-output"
  ]
}), async ({ page, request }, testInfo) => {
  const marker = `TERMINAL_IO_${Date.now()}`
  const repo = await createOwnedLocalRepo({ name: `terminal-io-${Date.now()}`, fixture: "none", files: { "terminal-marker.txt": `${marker}\n` } })
  await bootWorkbench(page)
  await openOwnedRepo(page, repo)
  const sessionId = await openTerminalThroughSlash(page, repo.path)

  const initial = (await listPtys(page, request)).find((session) => session.sessionId === sessionId)
  expect(initial).toMatchObject({ sessionId, kind: "terminal", cwd: repo.path, alive: true })
  expect(initial!.pid).toBeGreaterThan(1)
  expect(pidIsAlive(initial!.pid)).toBe(true)

  await typeTerminalLine(page, sessionId, "printf '%s%s\\n' 'TERMINAL_IO_' \"$(cat terminal-marker.txt | cut -d_ -f3-)\"")
  const terminal = page.getByTestId(`terminal-${sessionId}`)
  await expect(terminal.locator(".xterm-rows")).toContainText(marker, { timeout: 15_000 })
  await expect.poll(async () => (await readPty(page, request, sessionId)).output).toContain(marker)

  const resizing = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === `/api/pty/${sessionId}/resize`)
  await page.setViewportSize({ width: 720, height: 560 })
  const resizeResponse = await resizing
  expect(resizeResponse.status()).toBe(200)
  const geometry = resizeResponse.request().postDataJSON() as { readonly cols: number; readonly rows: number }
  expect(geometry.cols).toBeGreaterThan(1)
  expect(geometry.rows).toBeGreaterThan(0)
  await typeTerminalLine(page, sessionId, "printf '__PTY_SIZE__'; stty size")
  await expect.poll(async () => (await readPty(page, request, sessionId)).output)
    .toContain(`__PTY_SIZE__${geometry.rows} ${geometry.cols}`)

  await attachTerminalEvidence(testInfo, "terminal-input-resize", {
    session: initial,
    resize: geometry,
    scrollback: await readPty(page, request, sessionId)
  })
})

test("a terminal reconnect replays retained output and continues the same process", scenario("terminal.reconnect-replay", {
  capabilities: ["local.repositories", "local.terminal"],
  description: "Reloads the real workbench while its PTY stays alive, verifies replay into a fresh xterm, then sends more input to the same PID.",
  coverage: [
    "action:repo.open", "action:tab.terminal", "host:local", "path:persistence", "path:success", "door:slash",
    "dimension:keyboard", "dimension:websocket-reconnect", "dimension:scrollback-replay", "dimension:process-identity",
    "dimension:natural-exit", "evidence:same-pid-and-replayed-output"
  ]
}), async ({ page, request }, testInfo) => {
  const suffix = String(Date.now())
  const replayMarker = `REPLAY_BEFORE_${suffix}`
  const afterMarker = `REPLAY_AFTER_${suffix}`
  const repo = await createOwnedLocalRepo({ name: `terminal-replay-${suffix}`, fixture: "none" })
  await bootWorkbench(page)
  await openOwnedRepo(page, repo)
  const sessionId = await openTerminalThroughSlash(page, repo.path)
  const before = (await listPtys(page, request)).find((session) => session.sessionId === sessionId)!

  await typeTerminalLine(page, sessionId, `printf '%s%s\\n' 'REPLAY_BEFORE_' '${suffix}'`)
  await expect.poll(async () => (await readPty(page, request, sessionId)).output).toContain(replayMarker)
  await page.reload({ waitUntil: "domcontentloaded" })
  const terminal = page.getByTestId(`terminal-${sessionId}`)
  await expect(terminal).toBeVisible()
  await expect(terminal.locator(".xterm-rows")).toContainText(replayMarker, { timeout: 15_000 })
  const renderedAfterReplay = await terminal.locator(".xterm-rows").innerText()
  expect(renderedAfterReplay.match(new RegExp(replayMarker, "g")) ?? []).toHaveLength(1)

  const afterReload = (await listPtys(page, request)).find((session) => session.sessionId === sessionId)!
  expect(afterReload).toMatchObject({ pid: before.pid, alive: true, cwd: repo.path })
  expect(pidIsAlive(before.pid)).toBe(true)
  await typeTerminalLine(page, sessionId, `printf '%s%s\\n' 'REPLAY_AFTER_' '${suffix}'`)
  await expect(terminal.locator(".xterm-rows")).toContainText(afterMarker)
  await expect.poll(async () => (await readPty(page, request, sessionId)).output).toContain(afterMarker)
  await typeTerminalLine(page, sessionId, "exit 7")
  await expect(terminal.locator(".xterm-rows")).toContainText("process exited (7)", { timeout: 15_000 })
  await expect.poll(async () => (await listPtys(page, request)).find((session) => session.sessionId === sessionId))
    .toMatchObject({ alive: false, exitCode: 7, pid: before.pid })
  await expect.poll(() => pidIsAlive(before.pid)).toBe(false)
  await attachTerminalEvidence(testInfo, "terminal-reconnect-replay", {
    before,
    afterReload,
    scrollback: await readPty(page, request, sessionId),
    renderedReplayOccurrences: 1
  })
})

test("two real terminal sessions remain isolated and can be selected and read", scenario("terminal.sessions-select-read-isolation", {
  capabilities: ["local.repositories", "local.terminal"],
  description: "Runs distinct output in two real PTYs, switches sessions through UI doors, and reads one session through the tab.read flow.",
  coverage: [
    "action:repo.open", "action:tab.terminal", "action:tab.select", "action:tab.read", "host:local", "path:success",
    "path:keyboard", "door:slash", "door:user-only", "dimension:keyboard", "dimension:session-list", "dimension:session-isolation",
    "dimension:verbose-readback", "evidence:independent-pty-scrollback"
  ]
}), async ({ page, request }, testInfo) => {
  const suffix = String(Date.now())
  const firstMarker = `FIRST_SESSION_${suffix}`
  const secondMarker = `SECOND_SESSION_${suffix}`
  const repo = await createOwnedLocalRepo({ name: `terminal-sessions-${suffix}`, fixture: "none" })
  await bootWorkbench(page)
  await openOwnedRepo(page, repo)
  const firstId = await openTerminalThroughSlash(page, repo.path)
  await typeTerminalLine(page, firstId, `printf '%s%s\\n' 'FIRST_SESSION_' '${suffix}'`)
  await expect.poll(async () => (await readPty(page, request, firstId)).output).toContain(firstMarker)
  await page.keyboard.press("Meta+1")
  await expect(page.getByTestId("transcript")).toBeVisible()
  const secondId = await openTerminalThroughSlash(page, repo.path)
  await typeTerminalLine(page, secondId, `printf '%s%s\\n' 'SECOND_SESSION_' '${suffix}'`)
  await expect.poll(async () => (await readPty(page, request, secondId)).output).toContain(secondMarker)

  const sessions = await listPtys(page, request)
  const owned = sessions.filter((session) => session.sessionId === firstId || session.sessionId === secondId)
  expect(owned).toHaveLength(2)
  expect(new Set(owned.map((session) => session.pid)).size).toBe(2)
  expect((await readPty(page, request, firstId)).output).not.toContain(secondMarker)
  expect((await readPty(page, request, secondId)).output).not.toContain(firstMarker)

  await page.keyboard.press("Meta+1")
  await command(page, `/tab.select ${firstId}`)
  await expect(page.getByTestId(`terminal-${firstId}`)).toBeVisible()
  await expect(page.getByTestId(`terminal-${secondId}`)).toBeHidden()

  await page.keyboard.press("Meta+1")
  await command(page, "/verbose")
  await command(page, `/tab.read ${firstId}`)
  await page.keyboard.press("Meta+1")
  const trace = page.getByTestId("transcript").locator(".tool-act-line").filter({ hasText: `You ran /tab.read ${firstId}` }).last()
  await expect(trace).toContainText(firstMarker)
  await expect(trace).not.toContainText(secondMarker)
  await attachTerminalEvidence(testInfo, "terminal-session-isolation", {
    sessions: owned,
    first: await readPty(page, request, firstId),
    second: await readPty(page, request, secondId)
  })
})

test("close cancel preserves a live PTY and close confirm reaps its process", scenario("terminal.close-cancel-confirm-cleanup", {
  capabilities: ["local.terminal"],
  description: "Exercises keyboard close, cancels once, then confirms and verifies both the server record and operating-system process are gone.",
  coverage: [
    "action:tab.terminal", "action:tab.close", "action:tab.close.cancel", "action:tab.close.confirm", "host:local",
    "path:success", "path:keyboard", "door:slash", "door:button", "door:user-only", "dimension:keyboard", "dimension:close-confirmation",
    "dimension:process-cleanup", "evidence:pty-list-and-os-pid"
  ]
}), async ({ page, request }, testInfo) => {
  await bootWorkbench(page)
  const sessionId = await openTerminalThroughSlash(page)
  const session = (await listPtys(page, request)).find((candidate) => candidate.sessionId === sessionId)!
  expect(pidIsAlive(session.pid)).toBe(true)

  await page.keyboard.press("Meta+w")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Cancel", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId(`terminal-${sessionId}`)).toBeVisible()
  expect((await listPtys(page, request)).find((candidate) => candidate.sessionId === sessionId)).toMatchObject({ alive: true, pid: session.pid })
  expect(pidIsAlive(session.pid)).toBe(true)

  await page.keyboard.press("Meta+w")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Close session", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(page.getByTestId(`terminal-${sessionId}`)).toHaveCount(0)
  await expect.poll(async () => (await listPtys(page, request)).some((candidate) => candidate.sessionId === sessionId)).toBe(false)
  await expect.poll(() => pidIsAlive(session.pid)).toBe(false)
  forgetOwnedSession(sessionId)
  await attachTerminalEvidence(testInfo, "terminal-close-cleanup", {
    session,
    listAfterClose: await listPtys(page, request),
    processAliveAfterClose: pidIsAlive(session.pid)
  })
})
