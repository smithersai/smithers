import { scenario } from "./coverage/types"
import { command, expect, realApi, test } from "./support/test"
import {
  attachJson,
  bootRepositoryWorkbench,
  createRepositoryPair,
  dismissComposer,
  enableVerboseEvidence,
  expectFlowOutcome,
  openOwnedRepository,
  selectOwnedRepository
} from "./repositories-github/local"

test.setTimeout(120_000)
test.use({ actionTimeout: 20_000 })

test(
  "two disposable repositories stay isolated through selection, tree navigation, and file reads",
  scenario("repositories.local-isolation-tree-files", {
    capabilities: ["local.repositories"],
    description: "Open two real jj repositories, navigate their actual directory cards, and prove same-named files remain bound to the selected filesystem.",
    coverage: [
      "action:repo.open", "action:repo.select", "action:files.list", "action:files.read",
      "host:local", "path:success", "door:slash", "door:button", "dimension:repository-isolation",
      "dimension:tree-navigation", "evidence:ui-api-filesystem-readback"
    ]
  }),
  async ({ page, request }, testInfo) => {
    const { first, second, marker } = await createRepositoryPair()
    await bootRepositoryWorkbench(page)
    await enableVerboseEvidence(page)
    const firstOpened = await openOwnedRepository(page, request, first)
    const secondOpened = await openOwnedRepository(page, request, second)

    await selectOwnedRepository(page, first)
    const listingResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/files")
    await command(page, "/files.list /")
    await dismissComposer(page)
    expect((await listingResponse).status()).toBe(200)
    const root = page.locator('.smithers-card[data-kind="file-list"]').last()
    await expect(root).toContainText(first.name)
    await expect(root.getByRole("button", { name: /docs/ })).toBeVisible()

    const nestedListing = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/files")
    await root.getByRole("button", { name: /docs/ }).click()
    expect((await nestedListing).status()).toBe(200)
    const docs = page.locator('.smithers-card[data-kind="file-list"]').last()
    await expect(docs).toContainText("docs")
    const firstRead = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/files")
    await docs.getByRole("button", { name: /shared\.txt/ }).click()
    expect((await firstRead).status()).toBe(200)
    const alpha = page.locator('.smithers-card[data-kind="file"]').last()
    await expect(alpha).toContainText(`ALPHA_TREE_TRUTH_${marker}`)
    await expect(alpha).not.toContainText(`BETA_TREE_TRUTH_${marker}`)

    await selectOwnedRepository(page, second)
    await command(page, "/files.read docs/shared.txt")
    await dismissComposer(page)
    const beta = page.locator('.smithers-card[data-kind="file"]').last()
    await expect(beta).toContainText(`BETA_TREE_TRUTH_${marker}`)
    await expect(beta).not.toContainText(`ALPHA_TREE_TRUTH_${marker}`)

    const firstDisk = await realApi(page, request, "POST", "/api/repo/files", { repoId: firstOpened.id, path: "docs/shared.txt" })
    const secondDisk = await realApi(page, request, "POST", "/api/repo/files", { repoId: secondOpened.id, path: "docs/shared.txt" })
    expect(firstDisk.status()).toBe(200)
    expect(secondDisk.status()).toBe(200)
    const firstBody = await firstDisk.json() as { readonly content?: unknown }
    const secondBody = await secondDisk.json() as { readonly content?: unknown }
    expect(firstBody.content).toBe(`ALPHA_TREE_TRUTH_${marker}\n`)
    expect(secondBody.content).toBe(`BETA_TREE_TRUTH_${marker}\n`)
    await attachJson(testInfo, "repository-isolation", { firstOpened, secondOpened, firstBody, secondBody })
  }
)

test(
  "a pinned repository reopens after host close and unpin remains effective after reload",
  scenario("repositories.local-pin-reopen-unpin", {
    capabilities: ["local.repositories", "local.repository-path-entry"],
    description: "Close an owned checkout behind the UI, select its durable pin to reopen it, then unpin and verify the choice remains unavailable after reload.",
    coverage: [
      "action:repo.open", "action:repo.select", "action:repo.unpin", "host:local", "path:success",
      "path:persistence", "door:slash", "dimension:pin-reopen", "dimension:reload", "evidence:host-inventory-readback"
    ]
  }),
  async ({ page, request }, testInfo) => {
    const { first } = await createRepositoryPair()
    await bootRepositoryWorkbench(page)
    await enableVerboseEvidence(page)
    const opened = await openOwnedRepository(page, request, first)
    const key = `local:${first.path}`

    const closed = await realApi(page, request, "POST", "/api/repo/close", { repoId: opened.id })
    expect(closed.status()).toBe(200)
    // A page restart makes the renderer re-read the host inventory while the
    // durable pin stays in SQLite. Selecting that pin must reopen its path.
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page).toHaveURL(/\/smithersai\/smithers$/)
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
    await expect(page.getByTestId("transcript")).toBeVisible()
    const reopening = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/open")
    await command(page, `/repo.select ${key}`)
    await expectFlowOutcome(page, "repo.select", key, "executed")
    expect((await reopening).status()).toBe(200)

    const reopenedInventoryResponse = await realApi(page, request, "GET", "/api/repos")
    expect(reopenedInventoryResponse.status()).toBe(200)
    const reopenedInventory = await reopenedInventoryResponse.json() as {
      readonly repos?: ReadonlyArray<{ readonly id?: unknown; readonly path?: unknown }>
    }
    expect(reopenedInventory.repos).toContainEqual(expect.objectContaining({ id: opened.id, path: first.path }))
    await attachJson(testInfo, "pin-reopen-inventory", { key, opened, reopenedInventory })

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page).toHaveURL(/\/smithersai\/smithers$/)
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
    await expect(page.getByTestId("transcript")).toBeVisible()
    await command(page, `/repo.unpin ${key}`)
    await expectFlowOutcome(page, "repo.unpin", key, "executed")
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
    await expect(page.getByTestId("transcript")).toBeVisible()
    await command(page, `/repo.select ${key}`)
    await expectFlowOutcome(page, "repo.select", key, "failed")
    await expect(page.getByText(`There is no pinned repository with key ${key}.`, { exact: true }).last()).toBeVisible()

    const inventoryResponse = await realApi(page, request, "GET", "/api/repos")
    expect(inventoryResponse.status()).toBe(200)
    const inventory = await inventoryResponse.json()
    await attachJson(testInfo, "pin-reopen-unpin", { key, opened, reopenedInventory, inventory })
  }
)

test(
  "the real folder prompt cancels cleanly and reports an invalid path without publishing a repo",
  scenario("repositories.local-folder-cancel-invalid", {
    capabilities: ["local.repositories", "local.repository-path-entry"],
    description: "Dismiss the actual browser folder prompt, then submit a missing directory and require the real host error with an unchanged inventory.",
    coverage: [
      "action:repo.open", "host:local", "path:error", "door:user-only",
      "dimension:folder-cancel", "dimension:invalid-path", "evidence:dialog-api-inventory"
    ]
  }),
  async ({ page, request }, testInfo) => {
    await bootRepositoryWorkbench(page)
    await enableVerboseEvidence(page)
    const beforeResponse = await realApi(page, request, "GET", "/api/repos")
    expect(beforeResponse.status()).toBe(200)
    const before = await beforeResponse.json() as { readonly repos?: ReadonlyArray<unknown> }

    let cancelledPrompt = ""
    page.once("dialog", async (dialog) => {
      cancelledPrompt = `${dialog.type()}:${dialog.message()}`
      await dialog.dismiss()
    })
    await command(page, "/repo.open")
    await expectFlowOutcome(page, "repo.open", "", "executed")
    const afterCancelResponse = await realApi(page, request, "GET", "/api/repos")
    expect(afterCancelResponse.status()).toBe(200)
    const afterCancel = await afterCancelResponse.json() as { readonly repos?: ReadonlyArray<unknown> }
    expect(cancelledPrompt).toBe("prompt:Repository path")
    expect(afterCancel.repos).toEqual(before.repos)

    const missing = `/tmp/smithers-e2e-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`
    page.once("dialog", async (dialog) => { await dialog.accept(missing) })
    const rejected = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/open")
    await command(page, "/repo.open")
    const rejectedResponse = await rejected
    expect(rejectedResponse.status()).toBeGreaterThanOrEqual(400)
    expect(rejectedResponse.status()).toBeLessThan(500)
    await expectFlowOutcome(page, "repo.open", "", "failed")
    const failedTrace = page.locator(".tool-act-line").filter({ hasText: "You ran /repo.open → failed" }).last()
    await expect(failedTrace).toContainText(/does not exist or cannot be read/i)
    const afterInvalidResponse = await realApi(page, request, "GET", "/api/repos")
    expect(afterInvalidResponse.status()).toBe(200)
    const afterInvalid = await afterInvalidResponse.json() as { readonly repos?: ReadonlyArray<unknown> }
    expect(afterInvalid.repos).toEqual(before.repos)
    await attachJson(testInfo, "folder-cancel-invalid", {
      cancelledPrompt,
      missing,
      rejectedStatus: rejectedResponse.status(),
      before,
      afterCancel,
      afterInvalid
    })
  }
)

test(
  "repo.tree projects a keyboard-operable directory tree in the canonical workbench",
  scenario("repositories.local-visible-tree", {
    capabilities: ["local.repositories"],
    description: "Require repo.tree's real directory read to produce the visible keyboard path promised by the repository tree flow on /owner/repo.",
    coverage: [
      "action:repo.open", "action:repo.tree", "host:local", "path:success", "path:keyboard",
      "door:slash", "door:button", "dimension:canonical-workbench", "dimension:keyboard", "evidence:repo-tree-network-and-dom"
    ]
  }),
  async ({ page, request }, testInfo) => {
    const { first } = await createRepositoryPair()
    await bootRepositoryWorkbench(page)
    await enableVerboseEvidence(page)
    await openOwnedRepository(page, request, first)
    const key = `local:${first.path}`
    await selectOwnedRepository(page, first)
    const loading = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/files")
    await command(page, `/repo.tree ${key}`)
    await expectFlowOutcome(page, "repo.tree", key, "executed")
    const response = await loading
    expect(response.status()).toBe(200)
    await dismissComposer(page)

    const tree = page.getByTestId(`repo-tree-${key}`)
    await expect(tree).toBeVisible()
    const docs = tree.getByRole("button", { name: /docs/ })
    await docs.focus()
    await expect(docs).toBeFocused()
    await docs.press("Enter")
    await expect(tree).toContainText("shared.txt")
    await attachJson(testInfo, "visible-repository-tree", { key, status: response.status() })
  }
)
