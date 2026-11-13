import type { Page } from "@playwright/test"

/** WebKit recognizes the read permission; the real Copy button supplies the write gesture. */
export const clipboardPermissions = (browserName: string) =>
  browserName === "webkit" ? ["clipboard-read"] : ["clipboard-read", "clipboard-write"]

/** Only Chromium needs (and supports) the renderer connection-state workaround after cached navigation. */
export const chromiumNetwork = (browserName: string, page: Page) =>
  browserName === "chromium" ? page.context().newCDPSession(page) : undefined

/** Read the real clipboard; WebKit's headless clipboard permits native paste but can deny readText. */
export const readClipboard = async (browserName: string, page: Page): Promise<string> => {
  if (browserName !== "webkit") return page.evaluate(() => navigator.clipboard.readText())
  const focused = await page.evaluateHandle(() => document.activeElement)
  // The temporary input receives a native paste.
  const input = await page.evaluateHandle(() => {
    const input = document.createElement("textarea")
    input.setAttribute("aria-label", "Clipboard check")
    input.style.cssText = "position:fixed;opacity:0;width:1px;height:1px"
    document.body.append(input)
    return input
  })
  try {
    await input.press("ControlOrMeta+v")
    return await input.inputValue()
  } finally {
    await input.evaluate(input => input.remove())
    await input.dispose()
    await focused.evaluate(element => (element as HTMLElement | null)?.focus())
    await focused.dispose()
  }
}
