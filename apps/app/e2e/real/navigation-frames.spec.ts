import { scenario } from "./coverage/types"
import { closeComposer, command, expect, openComposer, test } from "./support/test"
import {
  decodedFramePath,
  enterCanonicalRepositoryApp,
  enterUrlApp,
  expectSameElement,
  frameLocation,
  openPracticeIssues,
  openWikiForm,
  WIKI_FORM_CARD_ID
} from "./navigation-frames/cards"
import { downloadRecovery, takeDatabaseControl } from "./navigation-frames/storage"

test("a portable form card keeps its component and unfinished value through keyboard maximize/minimize, then Cancel dismisses durably", scenario("navigation.card.identity-dismiss", {
  capabilities: [],
  coverage: [
    "action:wiki.open",
    "action:form.set",
    "action:card.maximize",
    "action:card.minimize",
    "action:card.dismiss",
    "host:local",
    "host:production",
    "path:success",
    "path:persistence",
    "path:keyboard",
    "door:slash",
    "door:button",
    "door:user-only",
    "dimension:component-identity",
    "dimension:unfinished-form-state",
    "dimension:keyboard",
    "evidence:same-dom-node-and-reload"
  ],
  description: "The provider-free wiki form stays mounted and keeps an unfinished required field across keyboard frame transitions; its real card.dismiss Cancel persists removal."
}), async ({ page }) => {
  const marker = "navigation-identity-unsaved.md"
  const { card, path } = await openWikiForm(page, marker, enterCanonicalRepositoryApp)
  const original = await card.elementHandle()
  await expect(card).toHaveAttribute("data-maximized", "false")

  const maximize = card.getByRole("button", { name: "Maximize card", exact: true })
  await maximize.focus()
  await maximize.press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(card.getByRole("button", { name: "Restore", exact: true })).toBeFocused()
  await expect(path).toHaveValue(marker)
  await expectSameElement(card, original)

  await page.keyboard.press("Escape")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(maximize).toBeFocused()
  await expect(path).toHaveValue(marker)
  await expectSameElement(card, original)

  const cancel = card.getByTestId("flow-form-cancel")
  await expect(cancel).toHaveAttribute("data-flow", "card.dismiss")
  await cancel.focus()
  await cancel.press("Enter")
  await expect(card).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId(WIKI_FORM_CARD_ID)).toHaveCount(0)
})

test("URL-pointer mode traverses browser history and restores its maximized form pointer on reload", scenario("navigation.frame.url-history-reload", {
  capabilities: [],
  coverage: [
    "action:wiki.open",
    "action:form.set",
    "action:card.maximize",
    "action:card.minimize",
    "host:local",
    "path:success",
    "path:persistence",
    "door:slash",
    "door:button",
    "dimension:url-pointer-mode",
    "dimension:deep-link",
    "dimension:browser-history",
    "evidence:url-and-sqlite-reload"
  ],
  description: "In local /w URL-pointer mode, browser back/forward and reload reconstruct the durable form frame without claiming direct frame.back or frame.forward invocation."
}), async ({ page }) => {
  const marker = "navigation-url-mode.md"
  const { card, path } = await openWikiForm(page, marker, enterUrlApp)
  const rootUrl = page.url()
  expect(decodedFramePath(page)).toMatch(/^\/w\/workspace-main\/b\/branch-main\/f\/frame-root:branch-main$/)

  await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  const maximizedUrl = page.url()
  expect(maximizedUrl).not.toBe(rootUrl)
  expect(decodedFramePath(page)).toMatch(/^\/w\/workspace-main\/b\/branch-main\/f\/frame-card:branch-main:form-wiki\.open$/)
  await expect(card).toHaveAttribute("data-maximized", "true")

  await page.goBack()
  await expect(page).toHaveURL(rootUrl)
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(path).toHaveValue(marker)

  await page.goForward()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await page.reload()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(path).toHaveValue(marker)

  await card.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(page).toHaveURL(rootUrl)
  await page.reload()
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(path).toHaveValue(marker)
})

test("canonical slashless repository navigation keeps the URL fixed and persists frame pointers in history.state", scenario("navigation.frame.repo-history-state", {
  capabilities: [],
  coverage: [
    "action:wiki.open",
    "action:form.set",
    "action:card.maximize",
    "action:card.minimize",
    "host:local",
    "host:production",
    "path:success",
    "path:persistence",
    "door:slash",
    "door:button",
    "dimension:canonical-repository-url",
    "dimension:history-state",
    "dimension:browser-history",
    "evidence:fixed-url-state-and-reload"
  ],
  description: "A slashless /owner/repo entry remains exact while maximize, reload, restore, and browser traversal preserve distinct durable frame locations in history.state."
}), async ({ page }) => {
  const marker = "navigation-repo-history-state.md"
  const { card, path } = await openWikiForm(page, marker, enterCanonicalRepositoryApp)
  const repositoryUrl = page.url()
  const root = await frameLocation(page)
  expect(root.frameId).toBe(`frame-root:${root.branchId}`)

  await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  await expect(page).toHaveURL(repositoryUrl)
  const maximized = await frameLocation(page)
  expect(maximized).toMatchObject({ workspaceId: root.workspaceId, branchId: root.branchId })
  expect(maximized.frameId).not.toBe(root.frameId)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await page.reload()
  await expect(page).toHaveURL(repositoryUrl)
  expect(await frameLocation(page)).toEqual(maximized)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(path).toHaveValue(marker)

  await card.getByRole("button", { name: "Restore", exact: true }).click()
  await expect(page).toHaveURL(repositoryUrl)
  expect(await frameLocation(page)).toEqual(root)
  await page.goBack()
  await expect(page).toHaveURL(repositoryUrl)
  expect(await frameLocation(page)).toEqual(maximized)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await page.goForward()
  await expect(page).toHaveURL(repositoryUrl)
  expect(await frameLocation(page)).toEqual(root)
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(path).toHaveValue(marker)
})

test("direct Previous frame button and frame.forward slash command traverse one real frame history", scenario("navigation.frame.direct-controls", {
  capabilities: [],
  coverage: [
    "action:wiki.open",
    "action:form.set",
    "action:card.maximize",
    "action:frame.back",
    "action:frame.forward",
    "host:local",
    "host:production",
    "path:success",
    "door:button",
    "door:slash",
    "door:user-only",
    "dimension:direct-frame-controls",
    "evidence:button-and-command-state-transition"
  ],
  description: "The maximized card's frame.back button and the registered /frame.forward command independently traverse the same real browser history entries."
}), async ({ page }) => {
  const marker = "navigation-direct-frame-controls.md"
  const { card, path } = await openWikiForm(page, marker, enterCanonicalRepositoryApp)
  const root = await frameLocation(page)
  await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  const maximized = await frameLocation(page)

  const previous = card.getByTestId("frame-back")
  await expect(previous).toHaveAttribute("data-flow", "frame.back")
  await previous.click()
  expect(await frameLocation(page)).toEqual(root)
  await expect(card).toHaveAttribute("data-maximized", "false")

  await command(page, "/frame.forward")
  await expect(card).toHaveAttribute("data-maximized", "true")
  expect(await frameLocation(page)).toEqual(maximized)
  await closeComposer(page)
  await expect(path).toHaveValue(marker)
})

test("open in sidebar shares unfinished wiki state and persists both the session and embedded projection", scenario("navigation.card.open-in-sidebar", {
  capabilities: [],
  coverage: [
    "action:wiki.open",
    "action:form.set",
    "action:card.maximize",
    "action:tab.card",
    "action:tab.select",
    "action:sidebar.toggle",
    "host:local",
    "host:production",
    "path:success",
    "path:persistence",
    "door:slash",
    "door:button",
    "dimension:shared-card-record",
    "dimension:sidebar-session",
    "evidence:cross-projection-reload"
  ],
  description: "Open in sidebar uses the same durable provider-free form record: edits in the tab survive reload and appear in the embedded transcript projection."
}), async ({ page }) => {
  const first = "sidebar-shared-before.md"
  const second = "sidebar-shared-after.md"
  const { card } = await openWikiForm(page, first, enterCanonicalRepositoryApp)
  const repositoryUrl = page.url()
  await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  const openInSidebar = card.getByRole("button", { name: "Open in sidebar", exact: true })
  await expect(openInSidebar).toHaveAttribute("data-flow", "tab.card")
  await openInSidebar.click()

  const tab = page.getByTestId(`tab-${WIKI_FORM_CARD_ID}`)
  const tabCard = page.locator(".card-tab").getByTestId(WIKI_FORM_CARD_ID)
  await expect(tab).toHaveAttribute("data-active", "true")
  await expect(tabCard).toHaveAttribute("data-maximized", "false")
  await expect(tabCard.getByTestId("flow-form-path")).toHaveValue(first)
  await expect(page).toHaveURL(repositoryUrl)

  await tabCard.getByTestId("flow-form-path").fill(second)
  await page.reload()
  // Navigation chrome deliberately starts closed on each launch. Reopen it
  // through its real button before checking the durable tab and shared form.
  const sidebarToggle = page.getByRole("button", { name: "Smithers", exact: true })
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false")
  await sidebarToggle.click()
  await expect(tab).toHaveAttribute("data-active", "true")
  await expect(tabCard.getByTestId("flow-form-path")).toHaveValue(second)

  const workspace = page.getByTestId("workspace-name")
  await expect(workspace).toHaveAttribute("data-flow", "tab.select")
  await workspace.click()
  const transcriptCard = page.getByTestId("transcript").getByTestId(WIKI_FORM_CARD_ID)
  await expect(transcriptCard).toBeVisible()
  await expect(transcriptCard.getByTestId("flow-form-path")).toHaveValue(second)
  await expect(transcriptCard).toHaveAttribute("data-maximized", "false")
  await expect(tab).toHaveCount(1)
})

test("the shipped practice issue card keeps local history, reloads it, and discards forward state after new navigation", scenario("navigation.card.local-history", {
  capabilities: [],
  coverage: [
    "action:issues.view",
    "action:card.history.back",
    "action:card.history.forward",
    "host:local",
    "path:success",
    "path:persistence",
    "door:button",
    "dimension:card-local-history",
    "dimension:shipped-practice-capture",
    "evidence:sqlite-reload-and-card-history"
  ],
  description: "The shipped practice capture exercises only local issue-card history: one durable card retains its recorded stack through back, forward, divergent navigation, and reload."
}), async ({ page }) => {
  const card = await openPracticeIssues(page)

  await card.locator('[data-issue="3"] button[data-flow="issues.view"]').click()
  await expect(card).toHaveAttribute("data-kind", "issue")
  await expect(card.locator('article[data-issue="3"]')).toBeVisible()
  await expect(card.getByRole("button", { name: "Back in frame", exact: true })).toBeEnabled()
  await expect(card.getByRole("button", { name: "Forward in frame", exact: true })).toBeDisabled()

  await card.getByRole("button", { name: "Back in frame", exact: true }).click()
  await expect(card).toHaveAttribute("data-kind", "issue-list")
  await page.reload()
  await expect(card).toHaveAttribute("data-kind", "issue-list")
  await expect(card.getByRole("button", { name: "Forward in frame", exact: true })).toBeEnabled()

  await card.getByRole("button", { name: "Forward in frame", exact: true }).click()
  await expect(card.locator('article[data-issue="3"]')).toBeVisible()
  await card.getByRole("button", { name: "Back in frame", exact: true }).click()
  await card.locator('[data-issue="2"] button[data-flow="issues.view"]').click()
  await expect(card.locator('article[data-issue="2"]')).toBeVisible()
  await expect(card.getByRole("button", { name: "Forward in frame", exact: true })).toBeDisabled()
  await page.reload()
  await expect(card.locator('article[data-issue="2"]')).toBeVisible()
})

test("forking a historical form frame restores its recorded draft and isolates later source and fork edits", scenario("navigation.frame.form-draft-fork-isolation", {
  capabilities: [],
  coverage: [
    "action:wiki.open",
    "action:form.set",
    "action:card.maximize",
    "action:card.minimize",
    "action:frame.fork",
    "host:local",
    "host:production",
    "path:success",
    "path:persistence",
    "door:slash",
    "door:button",
    "door:user-only",
    "dimension:historical-form-frame",
    "dimension:unfinished-form-state",
    "dimension:branch-isolation",
    "evidence:recorded-versus-live-draft-and-reload"
  ],
  description: "A portable form fork starts at the frame's recorded draft, not the later live source draft, and both branches retain independent subsequent values across immediate reload and browser traversal."
}), async ({ page }) => {
  const recorded = "fork-recorded.md"
  const sourceLater = "fork-source-later.md"
  const forkOnly = "fork-only.md"
  const { card, path } = await openWikiForm(page, recorded, enterCanonicalRepositoryApp)
  const repositoryUrl = page.url()

  await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  const sourceFrame = await frameLocation(page)
  await expect(path).toHaveValue(recorded)
  await card.getByRole("button", { name: "Restore", exact: true }).click()
  await path.fill(sourceLater)
  await expect(path).toHaveValue(sourceLater)

  await page.goBack()
  await expect(page).toHaveURL(repositoryUrl)
  expect(await frameLocation(page)).toEqual(sourceFrame)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(path).toHaveValue(sourceLater)

  const fork = card.getByRole("button", { name: "Fork frame", exact: true })
  await expect(fork).toHaveAttribute("data-flow", "frame.fork")
  await fork.click()
  const forkFrame = await frameLocation(page)
  expect(forkFrame.branchId).not.toBe(sourceFrame.branchId)
  expect(forkFrame.frameId).not.toBe(sourceFrame.frameId)
  await expect(page).toHaveURL(repositoryUrl)
  await expect(path).toHaveValue(recorded)

  await path.fill(forkOnly)
  await expect(path).toHaveValue(forkOnly)
  await page.reload()
  await expect(page).toHaveURL(repositoryUrl)
  expect(await frameLocation(page)).toEqual(forkFrame)
  await expect(path).toHaveValue(forkOnly)

  await page.goBack()
  expect(await frameLocation(page)).toEqual(sourceFrame)
  await expect(path).toHaveValue(sourceLater)
  await page.goForward()
  expect(await frameLocation(page)).toEqual(forkFrame)
  await expect(path).toHaveValue(forkOnly)
})

test("the practice issue payload also isolates historical fork state and preserves its immediate-reload race contract", scenario("navigation.frame.practice-fork-isolation", {
  capabilities: [],
  coverage: [
    "action:issues.view",
    "action:card.maximize",
    "action:card.minimize",
    "action:frame.fork",
    "host:local",
    "path:success",
    "path:persistence",
    "door:button",
    "door:user-only",
    "dimension:historical-practice-frame",
    "dimension:branch-isolation",
    "dimension:immediate-reload",
    "evidence:bidirectional-branch-reload"
  ],
  description: "As adjacent payload-shape coverage, the shipped practice issue card forks its historical list while source issue 3 and fork issue 2 remain isolated through an immediate reload."
}), async ({ page }) => {
  const card = await openPracticeIssues(page)

  await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  const sourceFrameUrl = page.url()
  await card.getByRole("button", { name: "Restore", exact: true }).click()
  await card.locator('[data-issue="3"] button[data-flow="issues.view"]').click()
  await expect(card.locator('article[data-issue="3"]')).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(sourceFrameUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(card.locator('article[data-issue="3"]')).toBeVisible()
  await card.getByRole("button", { name: "Fork frame", exact: true }).click()
  const forkUrl = page.url()
  expect(forkUrl).not.toBe(sourceFrameUrl)
  expect(decodedFramePath(page)).toMatch(/^\/w\/workspace-main\/b\/branch-(?!main)[^/]+\/f\/frame-card:branch-/)
  await expect(card).toHaveAttribute("data-kind", "issue-list")

  await card.locator('[data-issue="2"] button[data-flow="issues.view"]').click()
  await expect(card.locator('article[data-issue="2"]')).toBeVisible()
  await page.reload()
  await expect(page).toHaveURL(forkUrl)
  await expect(card.locator('article[data-issue="2"]')).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(sourceFrameUrl)
  await expect(card.locator('article[data-issue="3"]')).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(forkUrl)
  await expect(card.locator('article[data-issue="2"]')).toBeVisible()
})

test("archive creates a durable new conversation whose recovery link restores the exact prior practice issue state", scenario("navigation.chat.archive-restore", {
  capabilities: [],
  coverage: [
    "action:issues.view",
    "action:chat.clear",
    "host:local",
    "path:success",
    "path:persistence",
    "door:slash",
    "door:button",
    "dimension:archive-restore",
    "dimension:conversation-isolation",
    "evidence:archive-link-and-sqlite-reload"
  ],
  description: "The local archive transaction starts a separate branch and its persisted link restores the exact prior shipped practice issue stack after reload."
}), async ({ page }) => {
  const card = await openPracticeIssues(page)
  await card.locator('[data-issue="3"] button[data-flow="issues.view"]').click()
  await expect(card.locator('article[data-issue="3"]')).toBeVisible()
  const archivedUrl = page.url()

  await command(page, "/chat.clear")
  const recoveryLink = page.getByRole("link", { name: "Open the archived conversation" })
  await expect(recoveryLink).toBeVisible()
  await expect(card).toHaveCount(0)
  await expect.poll(() => page.url()).not.toBe(archivedUrl)
  const freshUrl = page.url()
  await closeComposer(page)

  await page.reload()
  await expect(page).toHaveURL(freshUrl)
  await expect(recoveryLink).toBeVisible()
  await recoveryLink.click()
  await expect(page).toHaveURL(archivedUrl)
  await expect(card).toBeVisible()
  await expect(card.locator('article[data-issue="3"]')).toBeVisible()
  await page.reload()
  await expect(card.locator('article[data-issue="3"]')).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(freshUrl)
  await expect(recoveryLink).toBeVisible()
  await expect(card).toHaveCount(0)
})

test("an older physical OPFS schema stamp upgrades while preserving the current durable form row", scenario("navigation.storage.opfs-schema-stamp-upgrade", {
  capabilities: [],
  coverage: [
    "action:wiki.open",
    "action:form.set",
    "host:local",
    "host:production",
    "path:success",
    "path:persistence",
    "door:slash",
    "dimension:physical-opfs-database",
    "dimension:schema-stamp-upgrade-preservation",
    "evidence:physical-metadata-and-ui-reload"
  ],
  description: "A real SQLite metadata stamp one version behind is upgraded during boot while a row written with the current schema remains visible; this does not claim arbitrary historical-row migration."
}), async ({ page, context }) => {
  const marker = "physical-opfs-schema-stamp.md"
  const opened = await openWikiForm(page, marker, enterCanonicalRepositoryApp)
  await page.reload()
  await expect(opened.path).toHaveValue(marker)

  const database = await takeDatabaseControl(page, context)
  const versionRows = await database.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'")
  expect(versionRows).toHaveLength(1)
  const originalVersion = Number(versionRows[0]?.value)
  if (!Number.isSafeInteger(originalVersion) || originalVersion < 2) {
    throw new Error(`The isolated database cannot provide a genuine prior schema stamp: ${String(versionRows[0]?.value)}.`)
  }
  const olderVersion = String(originalVersion - 1)
  await database.execute("UPDATE smithers_metadata SET value = ? WHERE key = 'schema-version'", [olderVersion])
  expect(await database.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'"))
    .toEqual([{ value: olderVersion }])

  await database.page.goto(database.appUrl)
  await expect(database.page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect(database.page.getByTestId(WIKI_FORM_CARD_ID).getByTestId("flow-form-path")).toHaveValue(marker)

  const upgraded = await takeDatabaseControl(database.page, context)
  expect(await upgraded.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'"))
    .toEqual([{ value: String(originalVersion) }])
  expect(JSON.stringify(await upgraded.execute(
    "SELECT collection_id, row_key, value FROM smithers_collection_rows WHERE value LIKE ?",
    [`%${marker}%`]
  ))).toContain(marker)
})

test("a future-schema physical OPFS database fails closed, exports exact rows, and boots after its real bytes are restored", scenario("navigation.storage.opfs-failure-recovery", {
  capabilities: [],
  coverage: [
    "action:wiki.open",
    "action:form.set",
    "action:storage.recovery",
    "host:local",
    "host:production",
    "path:error",
    "path:persistence",
    "path:keyboard",
    "door:slash",
    "door:button",
    "door:user-only",
    "dimension:physical-opfs-database",
    "dimension:failure-recovery",
    "dimension:storage.recovery.export",
    "dimension:keyboard",
    "evidence:downloaded-sqlite-rows-and-healed-boot"
  ],
  description: "The shipped SQLite worker changes an isolated physical schema stamp; startup refuses, the UI exports exact rows, restoring the stamp recovers state, and the composer remains closed until opened by keyboard."
}), async ({ page, context }, testInfo) => {
  const marker = "physical-opfs-recovery.md"
  const futureVersion = "2147483647"
  const opened = await openWikiForm(page, marker, enterCanonicalRepositoryApp)
  await page.reload()
  await expect(opened.path).toHaveValue(marker)
  await command(page, "/storage.recovery")
  await expect(page.getByRole("button", { name: "Download local recovery file" })).toHaveAttribute("data-flow", "storage.recovery.export")
  await closeComposer(page)

  const database = await takeDatabaseControl(page, context)
  const markerRows = await database.execute(
    "SELECT collection_id, row_key, value FROM smithers_collection_rows WHERE value LIKE ?",
    [`%${marker}%`]
  )
  expect(JSON.stringify(markerRows)).toContain(marker)
  const versionRows = await database.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'")
  expect(versionRows).toHaveLength(1)
  const originalVersion = versionRows[0]?.value
  if (typeof originalVersion !== "string" || originalVersion === futureVersion) {
    throw new Error(`The isolated database returned an invalid starting schema version: ${String(originalVersion)}.`)
  }

  let faultInstalled = false
  try {
    await database.execute("UPDATE smithers_metadata SET value = ? WHERE key = 'schema-version'", [futureVersion])
    faultInstalled = true
    expect(await database.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'"))
      .toEqual([{ value: futureVersion }])

    await database.page.goto(database.appUrl)
    await expect(database.page.getByRole("heading", { name: "Smithers failed to start" })).toBeVisible()
    await expect(database.page.getByTestId("composer-input")).toHaveCount(0)
    await expect(database.page.locator("body")).not.toContainText(marker)

    const snapshot = await downloadRecovery(database.page, testInfo, "physical-opfs-recovery.json")
    expect(snapshot.session).toBe("unopened")
    expect(snapshot.sqlite?.find((table) => table.name === "smithers_metadata")?.rows)
      .toContainEqual([{ type: "text", value: "schema-version" }, { type: "text", value: futureVersion }])
    expect(JSON.stringify(snapshot.sqlite)).toContain(marker)
    await expect(database.page.locator("body")).not.toContainText(marker)
  } finally {
    if (faultInstalled) {
      await database.page.goto(database.controlUrl)
      await database.execute("UPDATE smithers_metadata SET value = ? WHERE key = 'schema-version'", [originalVersion])
      expect(await database.execute("SELECT value FROM smithers_metadata WHERE key = 'schema-version'"))
        .toEqual([{ value: originalVersion }])
      faultInstalled = false
    }
  }

  await database.page.goto(database.appUrl)
  await expect(database.page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect(database.page.getByTestId("composer-input")).toBeHidden()
  await expect(database.page.getByTestId(WIKI_FORM_CARD_ID).getByTestId("flow-form-path")).toHaveValue(marker)
  await openComposer(database.page)
  await expect(database.page.getByTestId("composer-input")).toBeVisible()
})
