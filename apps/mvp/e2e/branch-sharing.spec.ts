import { questionIn } from "./messages"
import type { Page } from "@playwright/test"
import { expect, type Tab, test } from "./devices"
import { me, requires } from "./target"
import { canWrite, cannotWrite, clearShares, emptyShape, holdLiveSessions, liveSessionsRevoked, requireSharingModels, settleSharingQuestions, sharingRepository, startRevocation, trackSharedBranch } from "./sharing"
import { expectServerError } from "./watch"

// The same UI/API proof uses local developer people or independently verified production test accounts.
// Production writes only to the dedicated scratch branch; its ordinary e2e conversation stays private.
requires("sharingPeople")

const REPO = sharingRepository("sharing")
const BRANCH = `/${REPO.owner}/${REPO.name}/tree/${REPO.ref}`

/** A container's first start may take a while on a cold machine. */
const MACHINE = 200_000

/**
 * A change runs as a flow on the owner's engine, then comes back through Electric. Every shape's long poll waits at
 * Electric at once over HTTP/2, which the dev server speaks as production does (docs/infrastructure.md#https-and-http2).
 */
const SYNC = 30_000

/** Opens the branch's page, `search` after it. */
const visit = (tab: Tab, search = "") => tab.page.goto(`${BRANCH}${search}`)

/** Waits for the branch's workspace: its name in its chrome. */
const workspace = (tab: Tab) =>
  expect(tab.page.getByRole("navigation", { name: "Branch" }), `${tab.name}: the branch opens`).toContainText(REPO.ref, {
    timeout: 30_000,
  })

const noAccess = (tab: Tab) => tab.page.getByText("No access", { exact: true })
/** The branch's chrome: its name, what this person may do on it (`Owner`, `Can edit`, `Can view`) and who is there. */
const chrome = (tab: Tab) => tab.page.getByRole("navigation", { name: "Branch" })
const conversation = (page: Page) => page.getByRole("region", { name: "Conversation", exact: true })
const avatar = (tab: Tab, name: string) =>
  tab.page.getByRole("list", { name: "People here" }).getByRole("button", { name, exact: true })
const frame = (page: Page) => page.frameLocator('iframe[title="Terminal"]').locator("body")

/** Maya's share dialog, opened from the branch's chrome. */
const shareDialog = async (maya: Tab) => {
  await maya.page.getByRole("navigation", { name: "Branch" }).getByRole("button", { name: "Share", exact: true }).click()
  const dialog = maya.page.getByRole("dialog", { name: `Share ${REPO.ref}` })
  await expect(dialog).toBeVisible()
  return dialog
}

/** Picks `option` in the select named `name` inside `scope`. */
const choose = async (maya: Tab, scope: ReturnType<Page["getByRole"]>, name: string, option: string) => {
  await scope.getByRole("combobox", { name, exact: true }).click()
  await maya.page.getByRole("option", { name: option, exact: true }).click()
}

/** Types `line` into the page's terminal frame and presses Enter. */
const type = async (page: Page, line: string) => {
  await page.locator('iframe[title="Terminal"]').click()
  await page.keyboard.type(line)
  await page.keyboard.press("Enter")
}

/** Maya's own shell on the branch's machine, opened if it isn't. */
const openTerminal = async (maya: Tab) => {
  await visit(maya, "?terminal=me")
  await workspace(maya)
  const open = maya.page.getByRole("button", { name: "Open terminal" })
  await expect(async () => {
    if ((await open.isVisible()) && (await open.isEnabled())) await open.click()
    await expect(frame(maya.page)).toContainText("/workspace", { timeout: 15_000 })
  }).toPass({ timeout: MACHINE })
}

test("branch sharing: shared to view, Ben watches Maya's terminal and can't type; to edit, he types and asks; removed, he is out at once", {
  annotation: {
    type: "summary",
    description: "Maya shares her branch with Ben: to view, he watches her terminal; to edit, he types and asks; removed, he is out at once.",
  },
}, async ({ devices }) => {
  test.setTimeout(8 * 60_000)
  const word = devices.word
  const [maya] = await devices.open("Maya")
  const other = await devices.openSharingPerson("teammate", maya!, `${REPO.owner}/${REPO.name}`, "Ben")
  const [ben] = other.tabs
  const BEN = other.login
  const MAYA = me().login
  await requireSharingModels(maya!.page, ben!.page)
  const branch = await trackSharedBranch(maya!.page, "sharing")
  let settled = false
  const textRooms: string[] = []
  ben!.page.on("websocket", (socket) => {
    const url = new URL(socket.url())
    if (url.pathname.startsWith("/api/texts/") && url.searchParams.get("conversation") === branch.conversationId) {
      textRooms.push(`${url.pathname}${url.search}`)
    }
  })
  try {
    await clearShares(maya!.page, branch, [other.personId, "repository"])

    // Private to Maya until she shares it.
    await visit(maya!)
    await workspace(maya!)
    await expect(chrome(maya!), "Maya owns the branch").toContainText("Owner")
    await visit(ben!)
    await expect(noAccess(ben!), "Ben: not shared with him yet").toBeVisible({ timeout: 30_000 })
    await expect(ben!.page.getByRole("navigation", { name: "Branch" })).toHaveCount(0)

    // Maya shares it with Ben to view.
    const dialog = await shareDialog(maya!)
    await dialog.getByRole("textbox", { name: "Add people" }).fill(BEN)
    await dialog.getByRole("button", { name: "Share", exact: true }).click()
    await expect(dialog.getByRole("combobox", { name: `Access for ${BEN}` })).toHaveText("Can view", { timeout: SYNC })
    await dialog.getByRole("button", { name: "Done" }).click()

    // Ben opens it: the workspace, read-only, and each sees the other in the header.
    await visit(ben!)
    await workspace(ben!)
    await expect(chrome(ben!), "Ben's chrome says he can view").toContainText("Can view")
    await expect(avatar(ben!, MAYA), "Ben sees Maya").toBeVisible({ timeout: 30_000 })
    await expect(avatar(ben!, BEN), "Ben sees himself").toBeVisible()
    await expect(avatar(maya!, BEN), "Maya sees Ben").toBeVisible({ timeout: 30_000 })
    // He sees the branch's prompt as it is typed, and can't change or send it (docs/features/coedit.md).
    await expect(ben!.composer).not.toBeEditable()
    await expect(ben!.page.getByRole("button", { name: "Send message" })).toHaveCount(0)
    await expect(ben!.chatButton).toHaveCount(0)

    // Maya's shell; Ben's Terminal view shows it, read-only.
    await openTerminal(maya!)
    await type(maya!.page, `echo shared-${word}`)
    await expect(frame(maya!.page)).toContainText(`shared-${word}`, { timeout: 30_000 })
    await visit(ben!, "?terminal=me")
    await expect(frame(ben!.page), "Ben watches Maya's shell").toContainText(`shared-${word}`, { timeout: 60_000 })
    await expect(ben!.page.getByRole("button", { name: "Open terminal" })).toHaveCount(0)

    await cannotWrite(ben!.page, branch, other.personId, "view_only")

    // The server refuses a viewer's input: a socket Ben opens himself attaches read-only, and what he sends never runs.
    const href = await ben!.page.getByRole("navigation", { name: "Terminals" }).getByRole("link", { name: MAYA }).getAttribute("href")
    const terminalId = new URL(href!, "http://app").searchParams.get("terminal")!
    const attached = await ben!.page.evaluate(async ({ terminalId, line }) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/terminals/${terminalId}`)
      socket.binaryType = "arraybuffer"
      const control = await new Promise<string>((resolve, reject) => {
        socket.addEventListener("message", (event) => typeof event.data === "string" && resolve(event.data))
        socket.addEventListener("close", (event) => reject(new Error(`closed ${event.code}`)))
      })
      socket.send(new TextEncoder().encode(line))
      while (socket.bufferedAmount > 0) await new Promise((resolve) => requestAnimationFrame(resolve))
      socket.close(1000)
      return JSON.parse(control) as unknown
    }, { terminalId, line: `echo bypass-${word}\r` })
    expect(attached).toEqual({ type: "ready", access: "read" })
    await type(maya!.page, `echo after-${word}`)
    await expect(frame(maya!.page)).toContainText(`after-${word}`, { timeout: 30_000 })
    await expect(frame(maya!.page), "Ben's bytes never reached the shell").not.toContainText(`bypass-${word}`)

    // Maya lets Ben edit: without a reload his terminal reattaches to type, and the composer appears.
    await visit(maya!)
    await workspace(maya!)
    const again = await shareDialog(maya!)
    await choose(maya!, again, `Access for ${BEN}`, "Can edit")
    await expect(again.getByRole("combobox", { name: `Access for ${BEN}` })).toHaveText("Can edit", { timeout: SYNC })
    await again.getByRole("button", { name: "Done" }).click()
    await expect(async () => {
      await type(ben!.page, `echo ben-${word}`)
      await expect(frame(ben!.page)).toContainText(`ben-${word}`, { timeout: 5_000 })
    }, "Ben types into Maya's shell").toPass({ timeout: 60_000 })
    await visit(maya!, `?terminal=${terminalId}`)
    await expect(frame(maya!.page), "Maya sees what Ben typed").toContainText(`ben-${word}`, { timeout: 30_000 })

    await canWrite(ben!.page, branch, other.personId)

    // Ben asks in the branch's conversation; Maya sees it live.
    await expect(chrome(ben!), "Ben's chrome says he can edit, without a reload").toContainText("Can edit", { timeout: 30_000 })
    await expect(ben!.chatButton, "Ben may ask now").toBeVisible({ timeout: 30_000 })
    const question = `Ben's question ${word}`
    await ben!.chatButton.click()
    await ben!.composer.fill(question)
    await ben!.composer.press("Enter")
    await expect(questionIn(conversation(maya!.page), question), "Maya sees Ben's question").toBeVisible({ timeout: SYNC })

    await settleSharingQuestions(ben!)
    settled = true

    // Hold independent sockets: the app unmounting its views cannot supply the server's revocation proof.
    expect(textRooms.length, "the prompt has a live text room").toBeGreaterThan(0)
    const textRoom = textRooms.at(-1)!
    await holdLiveSessions(ben!.page, [`/api/branches/${branch.branchId}/room`, textRoom, `/api/terminals/${terminalId}`])

    // Maya removes Ben: his open page is out at once, the terminal gone, and the conversation's shape serves him nothing.
    await visit(maya!)
    await workspace(maya!)
    const last = await shareDialog(maya!)
    const revoked = maya!.page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/branches/${branch.branchId}/shares` && response.request().method() === "POST")
    const revocationStartedAt = await startRevocation(ben!.page)
    await last.getByRole("button", { name: `Remove ${BEN}` }).click()
    expect((await revoked).status()).toBe(200)
    // Check at the write's receipt, before Electric or UI convergence can hide a delayed revocation.
    await liveSessionsRevoked(ben!.page, revocationStartedAt)
    await expect(last.getByRole("listitem").filter({ hasText: BEN })).toHaveCount(0, { timeout: SYNC })
    await last.getByRole("button", { name: "Done" }).click()
    const textId = new URL(textRoom, "http://app").pathname.split("/")[3]!
    expect(textId, "the revocation probe addresses the real text, without its query string").toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    await emptyShape(ben!.page, `/api/shapes/texts?text=${textId}&conversation=${branch.conversationId}&offset=-1`)
    await emptyShape(ben!.page, `/api/shapes/terminals?branch=${branch.branchId}&offset=-1`)
    await expect(noAccess(ben!), "Ben is out at once").toBeVisible({ timeout: 30_000 })
    await expect(ben!.page.locator('iframe[title="Terminal"]')).toHaveCount(0)
    await expect(conversation(ben!.page)).toHaveCount(0)
    const shape = await ben!.page.request.get(`/api/shapes/messages?conversation=${branch.conversationId}&offset=-1`)
    expect(shape.status()).toBe(200)
    const rows = ((await shape.json()) as Array<{ readonly value?: unknown }>).filter((message) => message.value !== undefined)
    expect(rows, "the shape serves Ben none of the conversation").toEqual([])
    await cannotWrite(ben!.page, branch, other.personId, "forbidden")
    await expect(avatar(maya!, BEN), "Ben left Maya's header").toHaveCount(0, { timeout: 30_000 })
  } finally {
    try {
        if (!settled) await settleSharingQuestions(ben!)
    } finally {
      await clearShares(maya!.page, branch, [other.personId, "repository"])
    }
  }
})

test("branch sharing: anyone in the repository with the link reaches Ben but never Gus, a Guest, who views only when named", {
  annotation: {
    type: "summary",
    description: "Shared with anyone in the repository, Ben opens Maya's branch; Gus, a Guest, never does by link and only views when named.",
  },
}, async ({ devices }) => {
  requires("sharingGuest")
  test.setTimeout(5 * 60_000)
  // Gus, a Guest, is refused the repository's TODOs.
  expectServerError(403, "/api/shapes/todos")
  expectServerError(403, "/api/shapes/todo-requests")
  const [maya] = await devices.open("Maya")
  const other = await devices.openSharingPerson("teammate", maya!, `${REPO.owner}/${REPO.name}`, "Ben")
  const [ben] = other.tabs
  const BEN = other.login
  const MAYA = me().login
  const guest = await devices.openSharingPerson("guest", maya!, `${REPO.owner}/${REPO.name}`, "Gus")
  const [gus] = guest.tabs
  const GUS = guest.login
  const branch = await trackSharedBranch(maya!.page, "sharing")
  try {
  await clearShares(maya!.page, branch, [other.personId, guest.personId, "repository"])
  await visit(maya!)
  await workspace(maya!)

  // Anyone in the repository with the link may view it.
  const dialog = await shareDialog(maya!)
  await choose(maya!, dialog, "General access", "Anyone in this repository with the link")
  await expect(dialog.getByRole("combobox", { name: "Link access" })).toHaveText("Can view", { timeout: SYNC })
  await dialog.getByRole("button", { name: "Done" }).click()

  // Ben, a Member, opens it to view; Gus, a Guest, doesn't.
  await visit(ben!)
  await workspace(ben!)
  await expect(ben!.chatButton).toHaveCount(0)
  await visit(gus!)
  await expect(noAccess(gus!), "the link never reaches a Guest").toBeVisible({ timeout: 30_000 })

  // Named, Gus opens it, but only to view, even shared to edit: GitHub gives a Guest no write.
  const named = await shareDialog(maya!)
  await named.getByRole("textbox", { name: "Add people" }).fill(GUS)
  await choose(maya!, named, "Access", "Can edit")
  await named.getByRole("button", { name: "Share", exact: true }).click()
  await expect(named.getByRole("combobox", { name: `Access for ${GUS}` })).toHaveText("Can edit", { timeout: SYNC })
  await named.getByRole("button", { name: "Done" }).click()
  await visit(gus!)
  await workspace(gus!)
  await expect(chrome(gus!), "a Guest shared to edit views").toContainText("Can view")
  await expect(avatar(gus!, MAYA)).toBeVisible({ timeout: 30_000 })
  await expect(gus!.chatButton).toHaveCount(0)
  await expect(gus!.composer).not.toBeEditable()
  await cannotWrite(gus!.page, branch, guest.personId, "view_only")

  // Restricted again: Ben, on the page, is out at once; Gus, named, stays.
  const restrict = await shareDialog(maya!)
  await choose(maya!, restrict, "General access", "Restricted")
  await expect(restrict.getByRole("combobox", { name: "Link access" })).toHaveCount(0, { timeout: SYNC })
  await restrict.getByRole("button", { name: "Done" }).click()
  await expect(noAccess(ben!), "Ben is out at once").toBeVisible({ timeout: 30_000 })
  await expect(noAccess(gus!)).toHaveCount(0)
  await expect(gus!.page.getByRole("navigation", { name: "Branch" })).toBeVisible()
  await cannotWrite(ben!.page, branch, other.personId, "forbidden")
  } finally {
    await clearShares(maya!.page, branch, [other.personId, guest.personId, "repository"])
  }
})
