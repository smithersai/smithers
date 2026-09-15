import type { APIRequestContext, Page } from "@playwright/test"
import { execFile } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  closeComposer,
  command,
  createOwnedLocalRepo,
  expect,
  realApi,
  registerOwnedRepo,
  type OwnedLocalRepo
} from "../support"

const exec = promisify(execFile)

export const WORKSPACE = `import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")
const lockfile = S.file("//yarn.lock")

export const Workspace = S.Workspace("targets-graph-e2e", {
  repository: "git+https://example.com/targets-graph-e2e.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ manifest: packageJson }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  repos: { tools: S.LocalRepository("tools") },
})
`

export const PACKAGE = `import { Smithers as S } from "@smthrs/targets"

const input = S.Filegroup({ srcs: [S.file("src/input.txt")] })
const prepare = S.Shell.Test({
  bun: "console.log('S07_PREPARE_STDOUT_EXACT')",
  data: [input],
  summary: "Prepare the deterministic target fixture.",
})
const successful = S.Shell.Test({
  bun: "console.log('S07_SUCCESS_STDOUT_EXACT'); console.error('S07_SUCCESS_STDERR_EXACT')",
  data: [prepare],
  summary: "Emit deterministic stdout and stderr, then exit zero.",
})
const failing = S.Shell.Test({
  bun: "console.log('S07_FAILURE_STDOUT_EXACT'); console.error('S07_FAILURE_STDERR_EXACT'); process.exit(23)",
  data: [prepare],
  summary: "Emit deterministic output, then exit 23.",
})
export const Package = S.Package({ targets: { input, prepare, successful, failing } })
`

export const GITHUB_PACKAGE = `import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "../PACKAGE.js"

const ciWorkflow = S.Github.Workflow({
  name: "s07-ci",
  on: { pullRequest: true },
  run: [root.successful],
})
const pipeline = S.Github.CiGen({ workflows: [ciWorkflow], changes: ["workflows/**"] })

export const Package = S.Package({ targets: { ciWorkflow, pipeline } })
`

export const CHILD_WORKSPACE = `import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")
const lockfile = S.file("//yarn.lock")

export const Workspace = S.Workspace("targets-graph-e2e-tools", {
  repository: "git+https://example.com/targets-graph-e2e-tools.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ manifest: packageJson }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

export const CHILD_PACKAGE = `import { Smithers as S } from "@smthrs/targets"

const childProbe = S.Shell.Test({
  bun: "console.log('S07_CHILD_STDOUT_EXACT')",
  summary: "A deterministic target in the tools workspace.",
})

export const Package = S.Package({ targets: { childProbe } })
`

export type TargetFixture = OwnedLocalRepo & { readonly input: string }

/** A committed disposable jj repository whose next working copy is initially clean. */
export const createTargetFixture = async (name: string): Promise<TargetFixture> => {
  const input = "fixture input before change\n"
  const repo = await createOwnedLocalRepo({
    name,
    fixture: "none",
    files: {
      ".smithers/WORKSPACE.ts": WORKSPACE,
      ".github/PACKAGE.ts": GITHUB_PACKAGE,
      "PACKAGE.ts": PACKAGE,
      "package.json": `${JSON.stringify({ name, private: true, engines: { node: ">=22.19.0" } }, null, 2)}\n`,
      "yarn.lock": "",
      "src/input.txt": input,
      "tools/.smithers/WORKSPACE.ts": CHILD_WORKSPACE,
      "tools/PACKAGE.ts": CHILD_PACKAGE,
      "tools/package.json": `${JSON.stringify({ name: `${name}-tools`, private: true, engines: { node: ">=22.19.0" } }, null, 2)}\n`,
      "tools/yarn.lock": ""
    }
  })
  await exec("jj", ["describe", "-m", "fixture baseline"], { cwd: repo.path })
  await exec("jj", ["new"], { cwd: repo.path })
  return { ...repo, input }
}

export const bootWorkbench = async (page: Page): Promise<void> => {
  await page.goto("/smithersai/smithers", { waitUntil: "domcontentloaded" })
  await expect(page.locator(".guide-shell")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect(page.getByTestId("transcript")).toBeVisible()
}

export const openTargetFixture = async (
  page: Page,
  request: APIRequestContext,
  repo: OwnedLocalRepo
): Promise<string> => {
  const opening = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/repo/open")
  await command(page, `/repo.open ${repo.path}`)
  const response = await opening
  expect(response.status()).toBe(200)
  let opened: { readonly id: string; readonly path?: string } | undefined
  await expect.poll(async () => {
    const listed = await realApi(page, request, "GET", "/api/repos")
    if (!listed.ok()) return listed.status()
    const body = await listed.json() as { readonly repos?: readonly { readonly id: string; readonly path?: string }[] }
    opened = body.repos?.find((candidate) => candidate.path === repo.path)
    return opened?.path
  }, { message: `opened repository ${repo.path} appears in the real host inventory` }).toBe(repo.path)
  expect(opened).toBeDefined()
  const id = opened!.id
  registerOwnedRepo({ id, path: repo.path })
  await closeComposer(page)
  return id
}

export const runCommand = async (page: Page, text: string): Promise<void> => {
  await command(page, text)
  await closeComposer(page)
}

export const card = (page: Page, kind: string) => page.locator(`.smithers-card[data-kind="${kind}"]`)

export const readJournal = async (repo: OwnedLocalRepo, runId: string): Promise<readonly Record<string, unknown>[]> => {
  const text = await readFile(join(repo.path, ".flows", "ui", "runs", `${runId}.jsonl`), "utf8")
  return text.split("\n").filter(Boolean).flatMap((line) => {
    const parsed = JSON.parse(line) as { readonly type?: unknown; readonly event?: Record<string, unknown> }
    return parsed.type === "event" && parsed.event !== undefined ? [parsed.event] : []
  })
}

export const changeInput = async (repo: TargetFixture): Promise<void> => {
  await writeFile(join(repo.path, "src/input.txt"), "fixture input after change\n")
}

export const replay = async (page: Page, request: APIRequestContext, runId: string): Promise<{
  readonly run: Record<string, unknown>
  readonly events: readonly Record<string, unknown>[]
}> => {
  const response = await realApi(page, request, "POST", "/api/targets/runs/replay", { runId })
  expect(response.status()).toBe(200)
  return await response.json() as { readonly run: Record<string, unknown>; readonly events: readonly Record<string, unknown>[] }
}
