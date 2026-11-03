import { expect, type Locator } from "@playwright/test"

// A TODO hangs under exactly one issue (decision 0153): a draft's Commit waits until its Issue picker has one.

/** Picks the newest open issue a draft's Issue picker lists; the repository must have one. */
export const chooseIssue = async (draft: Locator) => {
  const picker = draft.getByLabel("Issue")
  await expect(picker.locator("option"), "the repository has an open issue to hang the TODO under")
    .not.toHaveCount(1, { timeout: 60_000 })
  await picker.selectOption({ index: 1 })
}
