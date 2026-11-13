import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { BranchCompareContent } from "../src/features/branch/components/BranchCompare"
import type { PublicationRow } from "../src/features/branch/publishSchema"
import { compareOf } from "../src/features/branch/publishView"
import { comparisonKey } from "../src/features/pulls/contract"

const publication: PublicationRow = {
  branchId: "branch",
  repoId: "github/acme/repo",
  githubRef: "feature",
  baseRef: "main",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  prNumber: 7,
  updateState: null,
  syncedSha: null,
  syncState: null,
  syncConflicts: null,
  updatedAt: "2026-10-25",
}

describe("Branch Compare", () => {
  test.each([
    [false, false], [true, false], [false, true], [true, true],
  ])("renders the files %s and commits %s truncation receipts", (truncated, commitsTruncated) => {
    const view = compareOf(publication, [{
      id: comparisonKey(publication.repoId, publication.baseSha, publication.headSha),
      repoId: publication.repoId,
      status: "ready",
      commits: [{ sha: "c".repeat(40), headline: "Add greeting", authorLogin: "dev", authoredAt: null }],
      files: [{ filename: "greeting.txt", status: "added", additions: 1, deletions: 0, patch: "+hello" }],
      truncated,
      commitsTruncated,
    }])
    const html = renderToStaticMarkup(createElement(BranchCompareContent, { view }))
    expect(html).toContain("Add greeting")
    expect(html).toContain("greeting.txt")
    if (truncated || commitsTruncated) {
      expect(html).toContain('role="status"')
      expect(html).toContain("Incomplete comparison")
      expect(html).toContain("View on GitHub")
      expect(html).toContain(`href="https://github.com/acme/repo/compare/${publication.baseSha}...${publication.headSha}"`)
      expect(html).toContain('rel="noopener noreferrer"')
    } else {
      expect(html).not.toContain("Incomplete comparison")
      expect(html).not.toContain("View on GitHub")
    }
  })

  test.each([
    [{ kind: "loading" } as const, ""],
    [{ kind: "empty", title: "No changes" } as const, "No changes"],
    [{ kind: "failed", title: "Couldn't load" } as const, "Couldn&#x27;t load"],
  ])("renders a %s comparison without an incomplete receipt", (view, title) => {
    const html = renderToStaticMarkup(createElement(BranchCompareContent, { view }))
    if (view.kind === "loading") expect(html).toBe('<section class="branch-compare" aria-label="Compare"></section>')
    else expect(html).toContain(title)
    expect(html).not.toContain("Incomplete comparison")
    expect(html).not.toContain("View on GitHub")
  })
})
