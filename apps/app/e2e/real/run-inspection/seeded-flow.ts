import type { APIRequestContext, Page } from "@playwright/test"
import { closeComposer, command, expect, realApi } from "../support/test"
import { cloudRepoPath } from "../repositories-github/production"

/** Repository-owned prompt subjects, discovered when the disposable host restarts. */
export const SEEDED_FLOW = "timeline-probe"
export const FAILED_FLOW = "timeline-probe-failed"
export const MARKER_TEST = "timeline-marker.test.ts"

const flowText = (failure: boolean): string => [
  "---",
  "description: Exercise a real agent timeline in a disposable repository.",
  'capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:*"]',
  "model: coding/implement",
  "budget:",
  "  tokens: 80000",
  `  milliseconds: ${failure ? 30000 : 480000}`,
  "---", "",
  failure
    ? 'Read README.md in one cell and print its content. In the NEXT cell call bash with command "sleep 120" and timeoutMs 150000. Do not write any files. This subject intentionally exceeds its run budget. Do not finish early.'
    : [
      "Append exactly the marker from the arguments to README.md. Preserve all original bytes and add one final newline.",
      "Use one numbered step per model response, one JavaScript cell per step. Never combine steps in one response.",
      '1. Read README.md with ctx.call("read", {path:"README.md"}); save the returned content in a variable and print it. Do not write yet.',
      '2. In the next response call ctx.call("bash", {command:"bun test timeline-marker.test.ts", timeoutMs:120000}) and print the result. The marker assertion must fail before the edit.',
      '3. In the next response use ctx.call("write", {path:"README.md", content: ...}) to append the marker to the saved text. read.content omits its final LF, so append one newline before and after the marker.',
      '4. In the next response run the exact same bun test command and print the result. It must pass after the edit.',
      '5. In the next response read README.md again. Finish with ctx.done only if the exact marker line exists and the test passed.'
    ].join("\n")
].join("\n") + "\n"

export const readWorkspaceText = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string, path: string): Promise<string> => {
  const response = await realApi(page, request, "GET", cloudRepoPath(repo,
    `/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`))
  expect(response.status(), `workspace file ${path}`).toBe(200)
  const body = await response.json() as { content?: unknown; encoding?: unknown }
  expect(body.encoding).toBe("utf-8")
  expect(typeof body.content).toBe("string")
  return body.content as string
}

/** Measure after resume, using a new file so an earlier measurement cannot satisfy the readback. */
export const measureWorkspaceHost = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string): Promise<string> => {
  const path = `timeline-host.${crypto.randomUUID()}.txt`
  let sessionId: string | undefined
  try {
    await command(page, `/workspace.terminal ${workspaceId}`)
    await closeComposer(page)
    const terminal = page.getByTestId(`card-workspace-${workspaceId}`).locator('[data-testid^="terminal-"]')
    await expect(terminal).toBeVisible({ timeout: 90000 })
    sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length)
    await terminal.locator(".xterm-helper-textarea").focus()
    await page.keyboard.insertText(`sha256sum /usr/local/bin/smithers-coding-host > ${path}`)
    await page.keyboard.press("Enter")
    let content = ""
    await expect(async () => {
      content = await readWorkspaceText(page, request, repo, workspaceId, path)
      expect(content).toMatch(/^[0-9a-f]{64} /)
    }).toPass({ timeout: 45000 })
    return content.split(" ")[0]!
  } finally {
    if (sessionId !== undefined) {
      const response = await realApi(page, request, "POST", `${cloudRepoPath(repo, "/workspace/sessions")}/${encodeURIComponent(sessionId)}/destroy`)
      expect(response.status()).toBe(204)
    }
  }
}

/** Type real files through the PTY, then verify the bytes through the independent file API. */
export const writeSeededFlow = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string, marker: string): Promise<void> => {
  const files = new Map([
    [`flows/${SEEDED_FLOW}/flow.mdx`, flowText(false)],
    [`flows/${FAILED_FLOW}/flow.mdx`, flowText(true)],
    [MARKER_TEST, `import {test, expect} from "bun:test";\nimport {readFileSync} from "node:fs";\ntest("exact marker line", async () => { await Bun.sleep(20000); expect(readFileSync("README.md", "utf8").split(/\\r?\\n/)).toContain(${JSON.stringify(marker)}); }, 30000);\n`]
  ])
  const sessions = cloudRepoPath(repo, "/workspace/sessions")
  let sessionId: string | undefined
  try {
    await command(page, `/workspace.terminal ${workspaceId}`)
    await closeComposer(page)
    const terminal = page.getByTestId(`card-workspace-${workspaceId}`).locator('[data-testid^="terminal-"]')
    await expect(terminal).toBeVisible({ timeout: 90_000 })
    sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length)
    await terminal.locator(".xterm-helper-textarea").focus()
    for (const [path, content] of files) {
      const encoded = Buffer.from(content).toString("base64")
      await page.keyboard.insertText(`mkdir -p flows/${SEEDED_FLOW} flows/${FAILED_FLOW}; printf %s '${encoded}' | base64 -d > '${path}'`)
      await page.keyboard.press("Enter")
      await expect(async () => expect(await readWorkspaceText(page, request, repo, workspaceId, path)).toBe(content)).toPass({ timeout: 45000 })
    }
  } finally {
    if (sessionId !== undefined) {
      const destroyed = await realApi(page, request, "POST", `${sessions}/${encodeURIComponent(sessionId)}/destroy`)
      expect(destroyed.status(), "the owned terminal is destroyed").toBe(204)
    }
  }
}

/** Suspends and resumes the workspace, so the host restarts and discovers the repository's flows. */
export const restartWorkspaceHost = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string): Promise<void> => {
  const workspace = cloudRepoPath(repo, `/workspaces/${workspaceId}`)
  for (const [verb, settled] of [["suspend", "suspended"], ["resume", "running"]] as const) {
    await command(page, `/workspace.${verb} ${workspaceId}`)
    await closeComposer(page)
    await expect.poll(async () => {
      const response = await realApi(page, request, "GET", workspace)
      return response.status() === 200 ? String(((await response.json()) as { readonly status?: unknown }).status) : `http-${response.status()}`
    }, { timeout: 240_000, intervals: [1_000, 2_000, 5_000] }).toBe(settled)
  }
}

/** One gateway read that reports a slow or refusing gateway as a value instead of throwing. */
const catalogOnce = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string): Promise<ReadonlyArray<string> | undefined> => {
  try {
    const response = await realApi(page, request, "POST", "/api/workflow/rpc", { repo, procedure: "List", payload: { _tag: "flows" }, workspaceId })
    if (response.status() !== 200) return undefined
    const answer = await response.json() as { readonly ok?: boolean; readonly payload?: { readonly items?: ReadonlyArray<{ readonly flowId?: unknown }> } }
    if (answer.ok !== true) return undefined
    return (answer.payload?.items ?? []).flatMap((flow) => typeof flow.flowId === "string" ? [flow.flowId] : [])
  } catch {
    return undefined
  }
}

/**
 * Waits until the restarted host lists the seeded flow and then answers three
 * reads in a row. One good answer is not enough: the gateway flaps for minutes
 * after a resume, and a launch into a flap is refused upstream.
 */
export const awaitSeededFlow = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string): Promise<void> => {
  let steady = 0
  await expect.poll(async () => {
    const flows = await catalogOnce(page, request, repo, workspaceId)
    steady = flows !== undefined && flows.includes(SEEDED_FLOW) ? steady + 1 : 0
    return steady
  }, { message: `the restarted host must list ${SEEDED_FLOW} three reads in a row`, timeout: 420_000, intervals: [5_000] }).toBeGreaterThanOrEqual(3)
}
