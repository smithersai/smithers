import { describe, expect, it } from "bun:test"
import type { BrowserContext, Page } from "@playwright/test"
import { nativeTarget } from "../native-target"

const page = (url: string, nonce: string): Page => ({
  url: () => url,
  evaluate: async () => nonce
} as unknown as Page)
const context = (...pages: ReadonlyArray<Page>): BrowserContext => ({
  pages: () => [...pages]
} as unknown as BrowserContext)

describe("packaged native CDP target", () => {
  it("finds the nonce-bearing window in a later context after its route changes", async () => {
    const target = page("http://127.0.0.1:50668/owner/repo", "target-nonce")
    const wrong = context(page("http://127.0.0.1:50668/", "other-nonce"))
    const right = context(target)
    expect(await nativeTarget([wrong, right], "http://127.0.0.1:50668/", "target-nonce"))
      .toEqual({ context: right, page: target })
  })
})
