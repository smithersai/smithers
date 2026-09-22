import type { BrowserContext, Page } from "@playwright/test"

const ATTACH_TIMEOUT_MS = 30_000

/** Find the bridge-correlated CEF target across CDP contexts after it changes routes. */
export const nativeTarget = async (
  contexts: ReadonlyArray<BrowserContext>,
  windowUrl: string,
  targetId: string
): Promise<{ readonly context: BrowserContext; readonly page: Page }> => {
  const origin = new URL(windowUrl).origin
  const deadline = Date.now() + ATTACH_TIMEOUT_MS
  do {
    for (const context of contexts) {
      for (const page of context.pages()) {
        let pageOrigin: string
        try { pageOrigin = new URL(page.url()).origin } catch { continue }
        if (pageOrigin !== origin) continue
        const observed = await context.newCDPSession(page).then(async (session) => {
          try {
            const { targetInfo } = await session.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } }
            return targetInfo?.targetId
          } finally {
            await session.detach()
          }
        }).catch(() => undefined)
        if (observed === targetId) return { context, page }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  const observed = contexts.flatMap((context) => context.pages().map((page) => page.url()))
  throw new Error(`The packaged Electrobun context did not expose ${windowUrl}; CDP pages: ${JSON.stringify(observed)}.`)
}
