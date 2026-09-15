import type { APIRequestContext, Page, TestInfo } from "@playwright/test"
import {
  closeComposer,
  command,
  createOwnedLocalRepo,
  expect,
  realApi,
  registerOwnedRepo,
  type OwnedLocalRepo
} from "../support/test"

export const bootRepositoryWorkbench = async (page: Page): Promise<void> => {
  await page.goto("/smithersai/smithers", { waitUntil: "domcontentloaded" })
  await expect(page).toHaveURL(/\/smithersai\/smithers$/)
  await expect(page.locator(".guide-shell")).toHaveCount(0)
  await expect(page.getByTestId("transcript")).toBeVisible()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
}

export const enableVerboseEvidence = async (page: Page): Promise<void> => {
  await command(page, "/verbose")
  await expect(page.getByTestId("transcript")).toContainText("Verbose on")
}

export const expectFlowOutcome = async (
  page: Page,
  flow: string,
  args: string,
  outcome: "executed" | "failed"
): Promise<void> => {
  const invocation = `You ran /${flow}${args === "" ? "" : ` ${args}`}`
  await expect(page.locator(".tool-act-line").filter({ hasText: invocation }).last()).toContainText(`→ ${outcome}`)
}

export const openOwnedRepository = async (
  page: Page,
  request: APIRequestContext,
  repo: OwnedLocalRepo
): Promise<{ readonly id: string; readonly path: string; readonly name: string }> => {
  const opening = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/open")
  await command(page, `/repo.open ${repo.path}`)
  await expectFlowOutcome(page, "repo.open", repo.path, "executed")
  const response = await opening
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON()).toEqual({ path: repo.path })

  // Read after the UI has completed. Chromium can discard a response body
  // after the app consumes it, while this independent inventory remains stable.
  const inventoryResponse = await realApi(page, request, "GET", "/api/repos")
  expect(inventoryResponse.status()).toBe(200)
  const inventory = await inventoryResponse.json() as {
    readonly repos?: ReadonlyArray<{ readonly id?: unknown; readonly path?: unknown; readonly name?: unknown }>
  }
  const opened = inventory.repos?.find((candidate) => candidate.path === repo.path)
  expect(opened, `The completed repo.open must publish ${repo.path} in the real host inventory`).toBeDefined()
  expect(typeof opened?.id).toBe("string")
  expect(typeof opened?.name).toBe("string")
  const registered = { id: opened!.id as string, path: repo.path, name: opened!.name as string }
  registerOwnedRepo(registered)
  return registered
}

export const selectOwnedRepository = async (page: Page, repo: OwnedLocalRepo): Promise<void> => {
  const key = `local:${repo.path}`
  await command(page, `/repo.select ${key}`)
  await expectFlowOutcome(page, "repo.select", key, "executed")
}

export const attachJson = async (testInfo: TestInfo, name: string, value: unknown): Promise<void> => {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json"
  })
}

export const createRepositoryPair = async (): Promise<{
  readonly first: OwnedLocalRepo
  readonly second: OwnedLocalRepo
  readonly marker: string
}> => {
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const first = await createOwnedLocalRepo({
    name: `repository-alpha-${marker}`,
    fixture: "none",
    files: {
      "README.md": `# Alpha ${marker}\n`,
      "docs/shared.txt": `ALPHA_TREE_TRUTH_${marker}\n`
    }
  })
  const second = await createOwnedLocalRepo({
    name: `repository-beta-${marker}`,
    fixture: "none",
    files: {
      "README.md": `# Beta ${marker}\n`,
      "docs/shared.txt": `BETA_TREE_TRUTH_${marker}\n`
    }
  })
  return { first, second, marker }
}

export const dismissComposer = closeComposer
