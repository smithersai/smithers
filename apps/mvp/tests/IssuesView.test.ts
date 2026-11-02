import { IssuesView } from "@smthrs/ui"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"
import { listProps, listSyncOf, type ListRow } from "../src/features/issues/view"

test("an unsynced repository renders empty or Requested rows without a spinner or false counts", () => {
  const requested: ListRow = {
    id: "another-repository", number: 0, title: "New issue", state: "open", author: "", comments: 0,
    updatedAt: "", triage: "", pending: "requested", reason: "", local: 1,
  }
  for (const rows of [[], [requested]]) {
    const props = listProps(rows, undefined, { status: "allowed" })
    const html = renderToStaticMarkup(createElement(IssuesView, {
      repo: "octo/another", issues: props.issues, unknown: props.unknown,
    }))
    expect(html).not.toContain('aria-busy="true"')
    expect(html).not.toContain("Loading issues")
    expect(html).not.toContain("No issues")
    expect(html).not.toContain("0 open")
    if (rows.length !== 0) {
      expect(html).toContain("New issue")
      expect(html).toContain("Requested")
    }
  }
})

// webkit on production, 2026-11-02: a cold list of smithersai/smithers (4,400 rows) said "Issues not synced", and the
// pull requests' list marked itself busy, a spinner by 0002 §7, until its rows arrived. The screens pass a cold list
// as `unknown` with no `loading`: no busy marker, no placeholders, and the "Syncing…" line beside it says so.
test("a cold list is syncing and unknown: never busy, never not synced", () => {
  const sync = listSyncOf(true, true, { installed: false })
  expect(sync).toBe("syncing")
  const html = renderToStaticMarkup(createElement(IssuesView, { repo: "smithersai/smithers", issues: [], unknown: sync === "syncing" }))
  expect(html).not.toContain('aria-busy="true"')
  expect(html).not.toContain("No issues")
  expect(html).not.toContain("sui-issues-skeleton")
})
