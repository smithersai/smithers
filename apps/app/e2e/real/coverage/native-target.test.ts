import { describe, expect, it } from "bun:test"
import type { BrowserContext, Page } from "@playwright/test"
import { nativeTarget } from "../native-target"

const page = (url: string, targetId: string): Page => ({
  url: () => url,
  targetId
} as unknown as Page)
const context = (...pages: ReadonlyArray<Page>): BrowserContext => ({
  pages: () => [...pages],
  newCDPSession: async (candidate: Page) => ({
    send: async () => ({ targetInfo: { targetId: (candidate as Page & { targetId: string }).targetId } }),
    detach: async () => {}
  })
} as unknown as BrowserContext)

describe("packaged native CDP target", () => {
  it("finds the bridge-correlated window in a later context after its route changes", async () => {
    const target = page("http://127.0.0.1:50668/owner/repo", "target-id")
    const wrong = context(page("http://127.0.0.1:50668/", "other-id"))
    const right = context(target)
    expect(await nativeTarget([wrong, right], "http://127.0.0.1:50668/", "target-id"))
      .toEqual({ context: right, page: target })
  })
})
