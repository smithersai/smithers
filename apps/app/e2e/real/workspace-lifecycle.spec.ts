import { scenario } from "./coverage/types"
import { closeComposer, command, expect, realApi } from "./support/test"
import { expectFlowOutcome } from "./repositories-github/local"
import { attachProductionJson, bootProductionRepository, cloudRepoPath } from "./repositories-github/production"
import { workflowTest } from "./flow-execution/fixture"
import { bootWorkbench, createTargetFixture, openTargetFixture, runCommand } from "./targets-graph/fixture"
import { test } from "./support"

/*
 * These cases deliberately use the imported provider fixture. The fixture
 * creates a real GitHub source, imports it through Plue, and provisions a real
 * workspace; no route interception or fabricated workspace row can satisfy
 * this suite. Its teardown drains provider VMs before deleting repository
 * metadata, and preserves both dependencies when a provider job is ambiguous.
 */
workflowTest.setTimeout(600_000)
workflowTest.use({ actionTimeout: 45_000 })

type WorkspaceWire = {
  readonly id?: unknown
  readonly repo_full_name?: unknown
  readonly name?: unknown
  readonly status?: unknown
  readonly target_bookmark?: unknown
}

const workspacePath = (repo: string, id: string): string => cloudRepoPath(repo, `/workspaces/${encodeURIComponent(id)}`)

const expectWorkspaceRow = (row: WorkspaceWire, repo: string, id: string): void => {
  expect(row.id, "provider workspace id").toBe(id)
  expect(row.repo_full_name, "workspace repository scope").toBe(repo)
  expect(typeof row.name, "provider workspace name").toBe("string")
  expect(row.name, "provider workspace name").not.toBe("")
  expect(typeof row.status, "provider workspace status").toBe("string")
}

workflowTest(
  "a real workspace card reads every provider facet and preserves repository scope",
  scenario("workspaces.cloud-facets-provider-readback", {
    capabilities: ["identity", "cloud"],
    description: "Open the real imported workspace through the rendered UI, read files, services, sessions, snapshots, and egress from the provider, and verify every response remains bound to the exact repository and workspace id.",
    coverage: [
      "action:workspace.view", "action:workspace.facet", "action:workspace.files", "action:workspace.file",
      "action:workspace.services", "action:workspace.sessions", "action:workspace.egress",
      "host:production", "path:success", "door:slash", "door:button", "dimension:provider-readback",
      "dimension:workspace-scope", "dimension:facet-readback", "evidence:ui-cards-and-independent-provider-responses"
    ]
  }),
  async ({ page, request, workflowRepo }, testInfo) => {
    const id = workflowRepo.workspaceId
    expect(id, "the real provisioner must return an exact workspace id").toMatch(/^[a-f0-9-]{36}$/i)
    const workspaceId = id!
    await bootProductionRepository(page, workflowRepo.repo)

    const current = await realApi(page, request, "GET", workspacePath(workflowRepo.repo, workspaceId))
    expect(current.status()).toBe(200)
    const row = await current.json() as WorkspaceWire
    expectWorkspaceRow(row, workflowRepo.repo, workspaceId)

    await command(page, `/workspace.view ${workspaceId}`)
    await expectFlowOutcome(page, "workspace.view", workspaceId, "executed")
    await closeComposer(page)
    const card = page.getByTestId(`card-workspace-${workspaceId}`)
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card).toContainText(workflowRepo.repo)
    await expect(card).toContainText(String(row.name))

    const observed: Record<string, unknown> = { workspace: row, id: workspaceId }
    for (const [flow, suffix, bodyText] of [
      ["workspace.files", `/files?path=${encodeURIComponent("/")}`, "Files"],
      ["workspace.services", "/services", "Services"],
      ["workspace.sessions", "/workspace/sessions", "Sessions"],
      ["workspace.egress", "/egress?limit=100", "Egress"]
    ] as const) {
      const path = cloudRepoPath(workflowRepo.repo, suffix)
      const requestSeen = page.waitForResponse((response) =>
        response.request().method() === "GET" && new URL(response.url()).pathname + new URL(response.url()).search === path)
      const args = flow === "workspace.files" ? `/ ${workspaceId}` : workspaceId
      await command(page, `/${flow} ${args}`)
      await expectFlowOutcome(page, flow, args, "executed")
      await closeComposer(page)
      const response = await requestSeen
      expect(response.status(), `${bodyText} provider read`).toBe(200)
      const body = await response.json()
      observed[bodyText.toLowerCase()] = body
      expect(JSON.stringify(body), `${bodyText} response must remain workspace-scoped`).not.toContain("other-repository")
    }

    // The file read is a second, independently observed path. The root list
    // determines the path; a guessed fixture filename would weaken this test.
    const listing = observed.files as { readonly entries?: ReadonlyArray<{ readonly path?: unknown; readonly kind?: unknown }> }
    const candidate = listing.entries?.find((entry) => typeof entry.path === "string" && entry.kind === "file")
    if (candidate?.path !== undefined) {
      const path = String(candidate.path)
      const readPath = cloudRepoPath(workflowRepo.repo, `/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`)
      const readSeen = page.waitForResponse((response) =>
        response.request().method() === "GET" && new URL(response.url()).pathname + new URL(response.url()).search === readPath)
      await command(page, `/workspace.file ${path} ${workspaceId}`)
      await expectFlowOutcome(page, "workspace.file", `${path} ${workspaceId}`, "executed")
      await closeComposer(page)
      expect((await readSeen).status()).toBe(200)
    }
    await attachProductionJson(testInfo, "workspace-provider-facets", observed)
  }
)

test(
  "the local workspace heading renames through the real keyboard editor and survives cancel and reload",
  scenario("workspace.rename-editor-cancel-reload", {
    capabilities: ["local.repositories"],
    description: "Open a disposable real repository, use the rendered workspace heading editor, verify Escape leaves the durable name unchanged, then commit a name and read it back after reload.",
    coverage: [
      "action:repo.open", "action:workspace.rename.edit", "action:workspace.rename",
      "host:local", "path:success", "path:keyboard", "path:persistence", "door:button",
      "dimension:inline-editor", "dimension:escape-cancel", "dimension:reload", "dimension:keyboard",
      "evidence:heading-readback"
    ]
  }),
  async ({ page, request }) => {
    const repo = await createTargetFixture(`workspace-rename-${Date.now()}`)
    await bootWorkbench(page)
    await openTargetFixture(page, request, repo)

    const heading = page.getByTestId("workspace-name")
    await expect(heading).toHaveText("Workspace")
    await page.getByTestId("workspace-rename").click()
    const editor = page.getByTestId("workspace-name-input")
    await expect(editor).toBeVisible()
    await editor.fill("discarded name")
    await editor.press("Escape")
    await expect(page.getByTestId("workspace-name")).toHaveText("Workspace")

    await page.getByTestId("workspace-rename").click()
    await page.getByTestId("workspace-name-input").fill("Durable E2E Workspace")
    await page.getByTestId("workspace-name-input").press("Enter")
    await expect(page.getByTestId("workspace-name")).toHaveText("Durable E2E Workspace")

    // A real app reload must recover the persisted store event, rather than
    // merely retaining the mounted React state.
    await page.reload()
    await expect(page.getByTestId("workspace-name")).toHaveText("Durable E2E Workspace")

    // Exercise the blank-name boundary through the visible composer and prove
    // it cannot erase the previously committed heading.
    await runCommand(page, "/workspace.rename    ")
    await expect(page.getByTestId("workspace-name")).toHaveText("Durable E2E Workspace")
  }
)

workflowTest(
  "a real workspace suspends, resumes, and deletes only after exact readback",
  scenario("workspaces.cloud-lifecycle-suspend-resume-delete", {
    capabilities: ["identity", "cloud"],
    description: "Drive suspend and resume through the UI's real commands, independently poll each provider state transition, then type the exact workspace name and verify the provider and UI both report deletion.",
    coverage: [
      "action:workspace.suspend", "action:workspace.resume", "action:workspace.delete", "action:workspace.view",
      "host:production", "path:success", "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:state-transitions",
      "dimension:typed-delete-confirmation", "dimension:post-delete-readback", "evidence:provider-status-polls-and-404"
    ]
  }),
  async ({ page, request, workflowRepo }, testInfo) => {
    const id = workflowRepo.workspaceId
    expect(id, "the real provisioner must return an exact workspace id").toMatch(/^[a-f0-9-]{36}$/i)
    const workspaceId = id!
    await bootProductionRepository(page, workflowRepo.repo)
    const path = workspacePath(workflowRepo.repo, workspaceId)
    const beforeResponse = await realApi(page, request, "GET", path)
    expect(beforeResponse.status()).toBe(200)
    const before = await beforeResponse.json() as WorkspaceWire
    expectWorkspaceRow(before, workflowRepo.repo, workspaceId)
    const name = String(before.name)
    await command(page, `/workspace.view ${workspaceId}`)
    await expectFlowOutcome(page, "workspace.view", workspaceId, "executed")
    await closeComposer(page)
    const card = page.getByTestId(`card-workspace-${workspaceId}`)
    await expect(card).toBeVisible({ timeout: 60_000 })

    const transition = async (verb: "suspend" | "resume", expected: RegExp): Promise<WorkspaceWire> => {
      const mutation = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === `${path}/${verb}`)
      await command(page, `/workspace.${verb} ${workspaceId}`)
      await expectFlowOutcome(page, `workspace.${verb}`, workspaceId, "executed")
      await closeComposer(page)
      expect((await mutation).status()).toBe(200)
      let settled: WorkspaceWire | undefined
      await expect.poll(async () => {
        const response = await realApi(page, request, "GET", path)
        if (response.status() !== 200) return `http-${response.status()}`
        settled = await response.json() as WorkspaceWire
        expectWorkspaceRow(settled, workflowRepo.repo, workspaceId)
        return settled.status
      }, { timeout: 180_000, intervals: [1_000, 2_000, 5_000] }).toMatch(expected)
      expect(settled).toBeDefined()
      return settled!
    }

    const suspended = await transition("suspend", /^suspended$/)
    await expect(card).toContainText(/Suspended/i)
    const resumed = await transition("resume", /^(running|starting|pending)$/)
    await expect(card).toContainText(/Running|Starting|Pending/i)

    // Exercise the card's own typed-name gate before the destructive request.
    await card.getByRole("button", { name: "Delete", exact: true }).click()
    const confirmation = card.getByRole("textbox", { name: `Type ${name} to confirm the delete` })
    await expect(confirmation).toBeVisible()
    const deleteButton = card.getByRole("button", { name: "Delete permanently", exact: true })
    await expect(deleteButton).toBeDisabled()
    await confirmation.focus()
    await confirmation.fill(name)
    await expect(deleteButton).toBeEnabled()
    const deletion = page.waitForResponse((response) =>
      response.request().method() === "DELETE" && new URL(response.url()).pathname === path)
    await deleteButton.press("Enter")
    expect((await deletion).status()).toBe(204)
    await expect.poll(async () => (await realApi(page, request, "GET", path)).status(), { timeout: 60_000 }).toBe(404)
    await expect(card).toHaveCount(0)
    await attachProductionJson(testInfo, "workspace-lifecycle", {
      repo: workflowRepo.repo, workspaceId, name, before, suspended, resumed,
      deleteStatus: (await deletion).status(), finalStatus: 404
    })
  }
)
