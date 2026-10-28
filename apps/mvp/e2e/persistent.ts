import type { BrowserType } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { browserProfile } from "./browserProfile"

// Playwright's WebKit newContext is private browsing: OPFS is unavailable.
// Local-first tests need a normal device profile. Private browsing is tested
// separately in flow-editor-storage.spec.ts.
export const persistent = async (
  browser: BrowserType,
  options: NonNullable<Parameters<BrowserType["launchPersistentContext"]>[1]>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-webkit-"))
  try {
    // On macOS the embedder puts OPFS outside userDataDir, in Foundation's home. Cookies and IndexedDB respect
    // userDataDir, so sharing OPFS alone can make a new signed-out device inherit another device's sealed engine.
    // Give this browser process its own Foundation home as well; never erase another profile's storage.
    const context = await browser.launchPersistentContext(directory, browserProfile(browser.name(), process.platform, directory, options, process.env))
    return { context, close: async () => {
      try { await context.close() } finally { await rm(directory, { recursive: true, force: true }) }
    } }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
