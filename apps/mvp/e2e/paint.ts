import type { Page } from "@playwright/test"

// When the branch page painted its chrome and its conversation (docs/features/branch-workspace.md#the-page), recorded
// in the page on every animation frame: e2e/branch-load.spec.ts and e2e/electric-awake.spec.ts hold the conversation
// to `BUDGET` after the chrome.

/**
 * The most the conversation may follow the chrome by, in milliseconds. A warm load with no summaries in flight showed
 * it 0.8 s after the chrome on smithers.sh (branchprobe, 2026-10-22); a load behind 60 interrupted summaries, 19 to
 * 25 s (this test against that build).
 */
export const BUDGET = 3_000

declare global {
  interface Window {
    __shown?: { chrome?: number; conversation?: number }
  }
}

/** Records, in the page, when the branch's chrome and its conversation were first painted. */
export const watchPaint = () => {
  window.__shown = {}
  const painted = (selector: string) => {
    const element = document.querySelector(selector)
    return element !== null && element.getBoundingClientRect().height > 0
  }
  const frame = () => {
    const shown = window.__shown!
    const now = performance.now()
    if (shown.chrome === undefined && painted('nav[aria-label="Branch"]')) shown.chrome = now
    if (shown.conversation === undefined && painted('.branch-screen-conversation [aria-label="Conversation"], .branch-screen-conversation[aria-label="Conversation"]')) {
      shown.conversation = now
    }
    if (shown.chrome === undefined || shown.conversation === undefined) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

/** The page's paint times once both were painted. */
export const paintOf = async (page: Page) => {
  await page.waitForFunction(() => window.__shown?.chrome !== undefined && window.__shown.conversation !== undefined, undefined, {
    timeout: 60_000,
  })
  return page.evaluate(() => window.__shown as { chrome: number; conversation: number })
}
