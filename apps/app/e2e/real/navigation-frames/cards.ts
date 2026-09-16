import type { Locator, Page } from "@playwright/test"
import { appEntryPath, closeComposer, command, expect, openApp } from "../support/test"
import type { FlowName } from "../../../src/mainview/flows/FlowName"

const WIKI_FORM_FLOW: FlowName = "wiki.open"
export const WIKI_FORM_CARD_ID = `card-form-${WIKI_FORM_FLOW}`
export const PRACTICE_REPOSITORY = "practice:smithersai/hello-server"
export const LOCAL_REPOSITORY_PATH = "/smithersai/smithers"

export interface WikiForm {
  readonly card: Locator
  readonly path: Locator
}

export interface FrameLocation {
  readonly workspaceId: string
  readonly branchId: string
  readonly frameId: string
}

export type ConversationEntry = (page: Page) => Promise<void>

const expectAppReady = async (page: Page): Promise<void> => {
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
}

/** Enter the configured real app surface; production's marketing root is never used. */
export const enterPortableApp = async (page: Page): Promise<void> => {
  await openApp(page)
  await expectAppReady(page)
}

/** Enter URL-pointer mode. This surface is local-only because production's root is marketing. */
export const enterUrlApp = async (page: Page): Promise<void> => {
  await page.goto("/w/workspace-main/b/branch-main/f/frame-root%3Abranch-main")
  await expectAppReady(page)
  expect(decodedFramePath(page)).toBe("/w/workspace-main/b/branch-main/f/frame-root:branch-main")
}

/** Enter a canonical, slashless /owner/repo path whose frame pointer lives in history.state. */
export const enterCanonicalRepositoryApp = async (page: Page): Promise<void> => {
  await openApp(page)
  if (process.env.SMITHERS_REAL_E2E_HOST !== "production") await page.goto(LOCAL_REPOSITORY_PATH)
  await expectAppReady(page)
  const expectedPath = process.env.SMITHERS_REAL_E2E_HOST === "production" ? appEntryPath() : LOCAL_REPOSITORY_PATH
  expect(new URL(page.url()).pathname).toBe(expectedPath)
  expect(new URL(page.url()).pathname.endsWith("/")).toBe(false)
}

/** Open the provider-free, required-input wiki form through its real slash door. */
export const openWikiForm = async (
  page: Page,
  value: string,
  enter: ConversationEntry = enterPortableApp
): Promise<WikiForm> => {
  await enter(page)
  await command(page, "/wiki.open")
  const card = page.getByTestId(WIKI_FORM_CARD_ID)
  const input = card.getByTestId("flow-form-path")
  await expect(card).toBeVisible()
  await expect(card.locator('form[data-flow-name="wiki.open"]')).toBeVisible()
  await closeComposer(page)
  await input.fill(value)
  await expect(input).toHaveValue(value)
  return { card, path: input }
}

/** Open the shipped practice issue stack. It proves local card behavior, not a provider call. */
export const openPracticeIssues = async (page: Page): Promise<Locator> => {
  if (process.env.SMITHERS_REAL_E2E_HOST === "production") {
    // The signed-out practice tests must not enter the private canary repo.
    await page.goto(LOCAL_REPOSITORY_PATH)
    await expectAppReady(page)
  } else await enterUrlApp(page)
  await command(page, `/issues.list open ${PRACTICE_REPOSITORY}`)
  await closeComposer(page)
  const card = page.getByTestId("card-practice-issues")
  await expect(card).toHaveAttribute("data-kind", "issue-list")
  return card
}

export const expectSameElement = async (locator: Locator, original: Awaited<ReturnType<Locator["elementHandle"]>>): Promise<void> => {
  if (original === null) throw new Error("The card disappeared before its component identity could be captured.")
  expect(await locator.evaluate((current, prior) => current === prior, original)).toBe(true)
}

export const decodedFramePath = (page: Page): string => decodeURIComponent(new URL(page.url()).pathname)

/** Read the frame location from a canonical repository page's real browser history entry. */
export const frameLocation = async (page: Page): Promise<FrameLocation> => page.evaluate(() => {
  const location: unknown = typeof history.state === "object" && history.state !== null
    ? (history.state as { readonly location?: unknown }).location
    : undefined
  if (typeof location !== "object" || location === null) throw new Error("history.state has no frame location.")
  const candidate = location as Partial<FrameLocation>
  if (typeof candidate.workspaceId !== "string" || typeof candidate.branchId !== "string" || typeof candidate.frameId !== "string") {
    throw new Error("history.state carries an invalid frame location.")
  }
  return { workspaceId: candidate.workspaceId, branchId: candidate.branchId, frameId: candidate.frameId }
})
