import type { APIRequestContext, Locator, Page } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { command, expect, realApi, registerOwnedRepo, type OwnedLocalRepo } from "../support"

export const writeRepoFiles = async (repo: OwnedLocalRepo, files: Readonly<Record<string, string | Uint8Array>>): Promise<void> => {
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(repo.path, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
}

export const openRepo = async (page: Page, request: APIRequestContext, repo: OwnedLocalRepo): Promise<string> => {
  await command(page, `/repo.open ${repo.path}`)
  let opened: { id: string; path?: string } | undefined
  await expect.poll(async () => {
    const response = await realApi(page, request, "GET", "/api/repos")
    if (!response.ok()) return response.status()
    const body = await response.json() as { repos?: Array<{ id: string; path?: string }> }
    opened = body.repos?.find((candidate) => candidate.path === repo.path)
    return opened?.path
  }, { message: `slash-opened repository ${repo.path} appears in the real host inventory` }).toBe(repo.path)
  expect(opened, `opened repository ${repo.path} appears in the real host inventory`).toBeDefined()
  registerOwnedRepo({ id: opened!.id, path: repo.path })
  return opened!.id
}

export const fileCard = (page: Page, repoId: string, path: string): Locator =>
  page.getByTestId(`card-file-${repoId}-${path}`)

export const runAndClose = async (page: Page, text: string): Promise<void> => {
  await command(page, text)
  const input = page.getByTestId("composer-input")
  if (await input.isVisible()) await input.press("Escape")
}
