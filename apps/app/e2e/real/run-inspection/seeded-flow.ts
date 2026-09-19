import type { APIRequestContext, Page } from "@playwright/test"
import { closeComposer, command, expect, realApi } from "../support/test"
import { cloudRepoPath } from "../repositories-github/production"

/*
 * A run the agent loop journals, on a workspace that offers none.
 *
 * Only a PROMPT flow runs through the agent's cell loop, and only that loop
 * journals `control.agent.*` (frames, cells, calls). A fresh production
 * workspace registers nine module flows and no prompt flow, so a timeline
 * scenario has nothing to open. The host discovers flows from the repository's
 * own `flows/` directory, so the scenario gives its disposable repository one:
 * a file typed through the workspace terminal, the same door a person has.
 *
 * Three facts this file encodes, each measured on production 2026-09-19:
 *  - discovery runs when the host STARTS, never on a catalog read or a launch
 *    miss, so the workspace is suspended and resumed to restart the host;
 *  - after a resume `provision` answers `ready` from before the suspend while
 *    the gateway is still coming back (five 30 s timeouts, first answer at
 *    161 s), so the catalog is read patiently rather than trusted once;
 *  - the seat `coding/implement` is the host's own configured model, so the
 *    flow needs no provider key of its own.
 */

/** The flow's name: `naming: "path"` names a flow by its directory under `flows/`. */
export const SEEDED_FLOW = "timeline-probe"

/*
 * No line carries a single quote: each is typed inside one for `printf`.
 * The prompt asks for separate steps so the run opens more than one frame when
 * the model obliges; the scenario never depends on it.
 */
const FLOW_LINES: ReadonlyArray<string> = [
  "---",
  "description: Reads the README and appends one marker line, so its run can be inspected.",
  'capabilities: ["fs:read:**", "fs:write:**"]',
  "model: coding/implement",
  "budget:",
  "  tokens: 80000",
  "  milliseconds: 300000",
  "---",
  "",
  "# Append a marker to the README",
  "",
  "Work in separate steps, one cell each: first read README.md, then append the exact line given in the appended arguments to the end of README.md, then read README.md again to confirm the line is there, then finish and say what you wrote."
]

/** Types the flow file into the workspace checkout and destroys exactly the session it opened. */
export const writeSeededFlow = async (page: Page, request: APIRequestContext, repo: string, workspaceId: string): Promise<void> => {
  const sessions = cloudRepoPath(repo, "/workspace/sessions")
  let sessionId: string | undefined
  try {
    await command(page, `/workspace.terminal ${workspaceId}`)
    await closeComposer(page)
    const terminal = page.getByTestId(`card-workspace-${workspaceId}`).locator('[data-testid^="terminal-"]')
    await expect(terminal).toBeVisible({ timeout: 90_000 })
    sessionId = (await terminal.getAttribute("data-testid"))!.slice("terminal-".length)
    await terminal.locator(".xterm-helper-textarea").focus()
    const typed = async (line: string, done: string): Promise<void> => {
      await page.keyboard.type(line)
      await page.keyboard.press("Enter")
      await expect(terminal.locator(".xterm-rows")).toContainText(done, { timeout: 45_000 })
    }
    await typed(`mkdir -p flows/${SEEDED_FLOW} && echo SEED_DIR_DONE`, "SEED_DIR_DONE")
    const quoted = FLOW_LINES.map((line) => `'${line}'`).join(" ")
    await typed(`printf '%s\\n' ${quoted} > flows/${SEEDED_FLOW}/flow.mdx && echo SEED_LINES_$(wc -l < flows/${SEEDED_FLOW}/flow.mdx | tr -d ' ')`, `SEED_LINES_${FLOW_LINES.length}`)
  } finally {
    if (sessionId !== undefined) {
      const destroyed = await realApi(page, request, "POST", `${sessions}/${encodeURIComponent(sessionId)}/destroy`)
      expect(destroyed.status(), "the terminal session this scenario opened must be destroyed").toBe(204)
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
