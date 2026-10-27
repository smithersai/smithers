import type { BrowserType } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Playwright's WebKit newContext is private browsing: OPFS is unavailable.
// Local-first tests need a normal device profile. Private browsing is tested
// separately in flow-editor-storage.spec.ts.
export const persistent = async (
  browser: BrowserType,
  options: NonNullable<Parameters<BrowserType["launchPersistentContext"]>[1]>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-webkit-"))
  try {
    const context = await browser.launchPersistentContext(directory, options)
    return { context, close: async () => {
      try { await context.close() } finally { await rm(directory, { recursive: true, force: true }) }
    } }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
