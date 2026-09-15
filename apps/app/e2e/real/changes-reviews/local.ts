import { execFile as execFileCallback } from "node:child_process"
import { appendFile, readFile } from "node:fs/promises"
import { promisify } from "node:util"
import type { APIRequestContext, Page, TestInfo } from "@playwright/test"
import {
  createOwnedLocalRepo,
  expect,
  realApi,
  type OwnedLocalRepo
} from "../support/test"
import {
  attachJson,
  bootRepositoryWorkbench,
  enableVerboseEvidence,
  expectFlowOutcome,
  openOwnedRepository,
  selectOwnedRepository
} from "../repositories-github/local"

const execFile = promisify(execFileCallback)

const jj = async (repo: OwnedLocalRepo, args: ReadonlyArray<string>): Promise<string> => {
  const result = await execFile("jj", ["--ignore-working-copy", "-R", repo.path, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  })
  return result.stdout.trim()
}

export type LocalChangeFixture = {
  readonly repo: OwnedLocalRepo
  readonly repoKey: string
  readonly commits: readonly [string, string]
}

export type RepositorySnapshot = {
  readonly log: string
  readonly diff: string
  readonly readme: string
  readonly source: string
}

/** Create two described, immutable jj changes followed by an empty working copy. */
export const createLocalChangeFixture = async (): Promise<LocalChangeFixture> => {
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const repo = await createOwnedLocalRepo({
    name: `changes-review-${marker}`,
    fixture: "none",
    files: { "README.md": `# Change fixture ${marker}\n` }
  })
  await execFile("jj", ["-R", repo.path, "describe", "-m", `docs: establish ${marker}`])
  const first = await jj(repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
  await execFile("jj", ["-R", repo.path, "new"])
  await appendFile(`${repo.path}/README.md`, `\nFirst reviewed line ${marker}.\n`)
  await execFile("jj", ["-R", repo.path, "describe", "-m", `docs: extend ${marker}`])
  const second = await jj(repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
  await execFile("jj", ["-R", repo.path, "new"])
  await appendFile(`${repo.path}/src.ts`, `export const marker = ${JSON.stringify(marker)}\n`)
  return { repo, repoKey: `local:${repo.path}`, commits: [first, second] }
}

export const repositorySnapshot = async (fixture: LocalChangeFixture): Promise<RepositorySnapshot> => ({
  log: await jj(fixture.repo, [
    "log", "-r", "all()", "--no-graph",
    "-T", "change_id ++ \" \" ++ commit_id ++ \" \" ++ description.first_line() ++ \"\\n\""
  ]),
  diff: await jj(fixture.repo, ["diff", "--git", "-r", "@"]),
  readme: await readFile(`${fixture.repo.path}/README.md`, "utf8"),
  source: await readFile(`${fixture.repo.path}/src.ts`, "utf8")
})

export const bootOwnedChangeRepository = async (
  page: Page,
  request: APIRequestContext,
  fixture: LocalChangeFixture
): Promise<void> => {
  await bootRepositoryWorkbench(page)
  await enableVerboseEvidence(page)
  await openOwnedRepository(page, request, fixture.repo)
  await selectOwnedRepository(page, fixture.repo)
}

export const expectLocalChangeRefusal = async (
  page: Page,
  fixture: LocalChangeFixture
): Promise<void> => {
  const sentence = `Opening a Change from picked commits on ${fixture.repoKey} needs the rebase step in the workspace, which is not wired yet. /prs.create opens one from a bookmark.`
  // The transient toast is allowed to resolve before this assertion. The
  // verbose flow record is durable and carries the exact failure returned by
  // the product boundary, so it is the stable evidence surface.
  const flow = page.locator(".tool-act-line").filter({
    hasText: `You ran /change.open ${fixture.repoKey} ${fixture.commits.join(" ")}`
  }).last()
  await expect(flow).toContainText(sentence)
  await expectFlowOutcome(page, "change.open", `${fixture.repoKey} ${fixture.commits.join(" ")}`, "failed")
  await expect(page.locator('.smithers-card[data-kind="change"]')).toHaveCount(0)
}

export const assertRepositoryUnchanged = async (
  fixture: LocalChangeFixture,
  before: RepositorySnapshot,
  testInfo: TestInfo,
  attachment: string
): Promise<void> => {
  const after = await repositorySnapshot(fixture)
  expect(after).toEqual(before)
  await attachJson(testInfo, attachment, { before, after, repoKey: fixture.repoKey, commits: fixture.commits })
}

export const assertRepositoryStillOpen = async (
  page: Page,
  request: APIRequestContext,
  fixture: LocalChangeFixture
): Promise<void> => {
  const response = await realApi(page, request, "GET", "/api/repos")
  expect(response.status()).toBe(200)
  const body = await response.json() as { readonly repos?: ReadonlyArray<{ readonly path?: unknown }> }
  expect(body.repos).toContainEqual(expect.objectContaining({ path: fixture.repo.path }))
}
