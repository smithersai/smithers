import { expect, test } from "@playwright/test"
import type { Response } from "@playwright/test"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { localApiDelete, localApiGet } from "./localApi"

/*
 * Lane L4 (docs/LOCAL-APP.md "Harness detection"): `GET /api/harnesses`
 * reports the CLIs installed on this machine with their signed-in accounts,
 * the `+` menu lists Claude Code with the account email, and opening the
 * harness tab runs `claude` under the harness sandbox policy until its
 * banner shows in the emulator.
 *
 * These tests inspect real credentials and can launch installed harnesses.
 * They require explicit opt-in before even reading account state. Missing
 * credentials after opt-in still skip with a reason.
 */

test.skip(process.env.SMITHERS_E2E_HOST_HARNESSES !== "1", "set SMITHERS_E2E_HOST_HARNESSES=1 to inspect host credentials and launch installed harnesses")

interface HarnessRow {
  id: string
  displayName: string
  binary: string | null
  version: string | null
  status: string
  account: { email?: string; label?: string } | null
  launch: { argv: Array<string> }
}

const HARNESS_IDS = [
  "claude",
  "codex",
  "gemini",
  "kimi",
  "opencode",
  "opencode-kimi",
  "opencode-cerebras",
  "crush",
  "amp",
  "cursor-agent",
  "hermes",
  "pi"
]

/** The binary a harness launches: its own id, except variants that share one (OpenCode · Kimi runs `opencode`). */
const launchBinary = (id: string): string => (id === "opencode-kimi" || id === "opencode-cerebras" ? "opencode" : id)

/** The email `~/.claude.json` says Claude Code is signed in as, or undefined. */
const claudeEmail = (): string | undefined => {
  try {
    const state = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as { oauthAccount?: { emailAddress?: string } }
    const email = state.oauthAccount?.emailAddress
    return typeof email === "string" && email !== "" ? email : undefined
  } catch {
    return undefined
  }
}

const codexSignedIn = (): boolean => {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".codex", "auth.json"), "utf8")) as { tokens?: { id_token?: string } }
    return typeof auth.tokens?.id_token === "string"
  } catch {
    return false
  }
}

const isPtyCreate = (response: Response): boolean =>
  response.request().method() === "POST" && /\/api\/pty$/.test(response.url())

let openedSessionId: string | undefined

test.beforeEach(async ({ page }) => {
  openedSessionId = undefined
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test.afterEach(async ({ page, request }) => {
  if (openedSessionId === undefined) return
  await localApiDelete(page, request, `/api/pty/${openedSessionId}`)
  openedSessionId = undefined
})

test("GET /api/harnesses lists every contract id; claude and codex are signed in on this machine", async ({ page, request }) => {
  await page.goto("/")
  const response = await localApiGet(page, request, "/api/harnesses")
  expect(response.status()).toBe(200)
  const { harnesses } = (await response.json()) as { harnesses: Array<HarnessRow> }
  expect(harnesses.map((harness) => harness.id)).toEqual(HARNESS_IDS)
  for (const harness of harnesses) {
    expect(["signed-in", "api-key", "binary-only", "unavailable"]).toContain(harness.status)
    expect(harness.launch.argv[0]).toBe(launchBinary(harness.id))
    expect(harness.launch.argv).not.toContain("--dangerously-skip-permissions")
    if (harness.status === "unavailable") expect(harness.binary).toBeNull()
    else expect(harness.binary?.startsWith("/")).toBe(true)
  }
  const claude = harnesses.find((harness) => harness.id === "claude")
  const codex = harnesses.find((harness) => harness.id === "codex")
  expect(claude?.displayName).toBe("Claude Code")
  expect(codex?.displayName).toBe("Codex")

  const email = claudeEmail()
  test.skip(email === undefined, "~/.claude.json has no oauthAccount: Claude Code is not signed in on this machine")
  expect(claude).toMatchObject({ status: "signed-in", account: { email } })
  expect(claude?.version).toMatch(/^\d+\.\d+\.\d+/)
  test.skip(!codexSignedIn(), "~/.codex/auth.json has no id_token: Codex is not signed in on this machine")
  expect(codex).toMatchObject({ status: "signed-in" })
  expect(codex?.account?.email).toMatch(/@/)
})

test("the + menu lists the signed-in Claude account and launches Claude Code", async ({ page, request }) => {
  const email = claudeEmail()
  test.skip(email === undefined, "~/.claude.json has no oauthAccount: Claude Code is not signed in on this machine")
  await page.goto("/")
  const { harnesses } = (await (await localApiGet(page, request, "/api/harnesses")).json()) as { harnesses: Array<HarnessRow> }
  test.skip(harnesses.find((harness) => harness.id === "claude")?.binary === null, "claude is not installed on this machine")

  await page.getByTestId("tab-add").click()
  const row = page.getByTestId("tab-add-harness-claude")
  await expect(row).toContainText("Claude Code")
  await expect(row).toContainText(email ?? "")
  await expect(row).toBeEnabled()

  const creating = page.waitForResponse(isPtyCreate)
  await row.click()
  const response = await creating
  expect(response.status()).toBe(201)
  const { sessionId } = (await response.json()) as { sessionId: string }
  openedSessionId = sessionId
  await expect(page.getByTestId(`tab-${sessionId}`)).toHaveAttribute("data-active", "true")
  await expect(page.getByTestId(`tab-${sessionId}`)).toContainText("Claude Code")

  const listed = (await (await localApiGet(page, request, "/api/pty")).json()) as { sessions: Array<{ sessionId: string; kind: string; harnessId?: string }> }
  expect(listed.sessions.find((session) => session.sessionId === sessionId)).toMatchObject({ kind: "harness", harnessId: "claude" })

  /*
   * A previously trusted workspace shows the versioned banner. A fresh temp
   * workspace stops at Claude's safety question instead. Both prove the real
   * CLI launched; the test must not mutate the user's trust configuration.
   */
  const terminal = page.getByTestId(`terminal-${sessionId}`)
  await expect(terminal.locator(".xterm-rows")).toContainText("Claude Code", { timeout: 30_000 })
  await expect.poll(async () => terminal.locator(".xterm-rows").textContent(), { timeout: 30_000 })
    .toMatch(/v\d+\.\d+\.\d+|Quick safety check/)

  await page.getByTestId(`tab-close-${sessionId}`).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Close session", exact: true }).click()
  await expect(page.getByTestId(`tab-${sessionId}`)).toHaveCount(0)
  await expect
    .poll(async () => {
      const { sessions } = (await (await localApiGet(page, request, "/api/pty")).json()) as { sessions: Array<{ sessionId: string }> }
      return sessions.some((session) => session.sessionId === sessionId)
    }, { timeout: 15_000 })
    .toBe(false)
  openedSessionId = undefined
})
