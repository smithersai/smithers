import { questionIn } from "./messages"
import type { Page } from "@playwright/test"
import { expect, type Tab, test } from "./devices"
import { requires } from "./target"

// Sharing a branch, Google Docs style, end to end (decision 0013 §2, §4 and §5, docs/features/branch-workspace.md#sharing):
// real browsers on separate devices against the real app, ChatApi, the branch's room, its machine, Postgres and
// Electric. Maya is local development's developer and owns the fixture branch; Ben is its second person, a Member
// (`smithers_dev_person=teammate`), and Gus its Guest (`smithers_dev_person=guest`, worker/DevChatApi.ts). The fixture
// is the public `octocat/Hello-World`'s `test` branch, which no other suite opens; nothing is written to GitHub.

// Three people on one laptop exist only in local development; a deployment needs more real test accounts.
requires("devPeople")

const REPO = { owner: "octocat", name: "Hello-World", ref: "test" }
const BRANCH = `/${REPO.owner}/${REPO.name}/tree/${REPO.ref}`
const BEN = "local-teammate"
const GUS = "local-guest"
const MAYA = "local-developer"

/** A container's first start may take a while on a cold machine. */
const MACHINE = 200_000

/**
 * A change runs as a flow on the owner's engine, then comes back through Electric. Every shape's long poll waits at
 * Electric at once over HTTP/2, which the dev server speaks as production does (docs/infrastructure.md#https-and-http2).
 */
const SYNC = 30_000

/**
 * Maya's branch, as she tracks it, with nobody else on its list: the first run tracks it as hers, and every run starts
 * from a branch shared with nobody. Answers its ids.
 */
const reset = async (maya: Tab) => {
  const tracked = await maya.page.request.post("/api/branches", { data: REPO })
  expect([200, 201], "Maya tracks the fixture branch").toContain(tracked.status())
  const branch = (await tracked.json()) as { readonly branchId: string; readonly conversationId: string; readonly access: string }
  expect(branch.access, "the fixture branch is Maya's: no other suite opens it").toBe("owner")
  for (const grantee of [BEN, GUS, "repository"]) {
    const removed = await maya.page.request.post(`/api/branches/${branch.branchId}/shares`, { data: { grantee, access: null } })
    expect(removed.status(), `nobody is left on the list: ${grantee}`).toBe(200)
  }
  return branch
}

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
  const [ben] = await devices.openTeammate("Ben")
  const branch = await reset(maya!)

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

  // Ben asks in the branch's conversation; Maya sees it live.
  await expect(chrome(ben!), "Ben's chrome says he can edit, without a reload").toContainText("Can edit", { timeout: 30_000 })
  await expect(ben!.chatButton, "Ben may ask now").toBeVisible({ timeout: 30_000 })
  const question = `Ben's question ${word}`
  await ben!.chatButton.click()
  await ben!.composer.fill(question)
  await ben!.composer.press("Enter")
  await expect(questionIn(conversation(maya!.page), question), "Maya sees Ben's question").toBeVisible({ timeout: SYNC })

  // Maya removes Ben: his open page is out at once, the terminal gone, and the conversation's shape serves him nothing.
  await visit(maya!)
  await workspace(maya!)
  const last = await shareDialog(maya!)
  await last.getByRole("button", { name: `Remove ${BEN}` }).click()
  await expect(last.getByRole("listitem").filter({ hasText: BEN })).toHaveCount(0, { timeout: SYNC })
  await last.getByRole("button", { name: "Done" }).click()
  await expect(noAccess(ben!), "Ben is out at once").toBeVisible({ timeout: 30_000 })
  await expect(ben!.page.locator('iframe[title="Terminal"]')).toHaveCount(0)
  await expect(conversation(ben!.page)).toHaveCount(0)
  const shape = await ben!.page.request.get(`/api/shapes/messages?conversation=${branch.conversationId}&offset=-1`)
  expect(shape.status()).toBe(200)
  const rows = ((await shape.json()) as Array<{ readonly value?: unknown }>).filter((message) => message.value !== undefined)
  expect(rows, "the shape serves Ben none of the conversation").toEqual([])
  await expect(avatar(maya!, BEN), "Ben left Maya's header").toHaveCount(0, { timeout: 30_000 })
})

test("branch sharing: anyone in the repository with the link reaches Ben but never Gus, a Guest, who views only when named", {
  annotation: {
    type: "summary",
    description: "Shared with anyone in the repository, Ben opens Maya's branch; Gus, a Guest, never does by link and only views when named.",
  },
}, async ({ devices }) => {
  test.setTimeout(5 * 60_000)
  const [maya] = await devices.open("Maya")
  const [ben] = await devices.openTeammate("Ben")
  const [gus] = await devices.openAs("guest", "Gus")
  await reset(maya!)
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

  // Restricted again: Ben, on the page, is out at once; Gus, named, stays.
  const restrict = await shareDialog(maya!)
  await choose(maya!, restrict, "General access", "Restricted")
  await expect(restrict.getByRole("combobox", { name: "Link access" })).toHaveCount(0, { timeout: SYNC })
  await restrict.getByRole("button", { name: "Done" }).click()
  await expect(noAccess(ben!), "Ben is out at once").toBeVisible({ timeout: 30_000 })
  await expect(noAccess(gus!)).toHaveCount(0)
  await expect(gus!.page.getByRole("navigation", { name: "Branch" })).toBeVisible()
})
