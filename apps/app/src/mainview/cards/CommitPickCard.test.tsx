import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "../state/AppState"
import { CommitPickBody } from "./CommitPickCard"

const render = (branch: string, count: number) => renderToStaticMarkup(<CommitPickBody card={{
  id: "pick", kind: "commit-pick", title: "Commits", status: "active", createdAt: 1, ordinal: 1,
  payload: { repo: "practice:smithersai/hello-server", branch, targetBookmark: "main", picked: [1],
    rows: Array.from({ length: count }, (_, index) => ({ index: index + 1, commitId: "a".repeat(40),
      message: "Fix greeting", additions: 1, deletions: 1, locked: false })) }
} as Extract<Card, { kind: "commit-pick" }>} onRunCommand={() => {}} />)

test("one commit on the target bookmark has a singular header without a redundant target", () => {
  const html = render("main", 1)
  expect(html).toContain("1 commit on <code>main</code>")
  expect(html).not.toContain("onto")
})

test("multiple commits retain the recorded source and distinct target", () => {
  expect(render("smithers/fix-hello-3", 3)).toContain("3 commits on <code>smithers/fix-hello-3</code> · onto <code>main</code>")
})
