import { expect } from "@playwright/test"
import { showcase } from "../showcase"

/* The mirror's shapes follow state/seams/HistorySeam.test.ts (probed on smithersai/smithers). */
const REPO = "smithersai/smithers"
const API = `/api/repos/${REPO}`

const sha = (prefix: string): string => prefix.padEnd(40, "0")
const R = sha("00"), A1 = sha("a1"), E1 = sha("e1"), B1 = sha("b1"), B2 = sha("b2"), C1 = sha("c1"), E2 = sha("e2"), E3 = sha("e3"), M = sha("33")
const NOTES = sha("99")

const change = (changeId: string, commitId: string, description: string, parents: ReadonlyArray<string>) => ({
  change_id: changeId, commit_id: commitId, description, author_name: "will", author_email: "will@example.com",
  timestamp: "2026-09-20T00:00:00Z", has_conflict: false, is_empty: false, parent_change_ids: parents
})

const FEED = [
  change("c-e3", E3, "03 · The Stack lands issues in lanes", ["c-e2", "c-c1"]),
  change("c-m", M, "ci: pin the browser", ["c-r"]),
  change("c-c1", C1, "feat(stack): lanes with seats and clocks", ["c-e2"]),
  change("c-e2", E2, "02 · Targets are declared in PACKAGE.ts", ["c-e1", "c-b2"]),
  change("c-b2", B2, "feat(targets): declare targets", ["c-b1"]),
  change("c-b1", B1, "docs(targets): what a target is", ["c-e1"]),
  change("c-e1", E1, "01 · The workspace declares its toolchain", ["c-r", "c-a1"]),
  change("c-a1", A1, "feat(workspace): WORKSPACE.ts", ["c-r"]),
  change("c-r", R, "root", [])
]

const NOTE_B2 = [
  "---", "commit: b2", "---", "",
  "## Tried", "A single PACKAGE.json: lost type checking.", "",
  "## Evidence", "//packages/targets:test green at 4b1c.", ""
].join("\n")

const ref = (name: string, target: string) => ({ ref: name, object: { sha: target, type: "commit" } })

export default showcase({
  id: "history",
  order: 115,
  title: "History",
  summary: "The mythical history: epics, their atomic commits and notes.",
  flows: ["history.show"],
  run: async ({ page, app, backend }) => {
    await backend.cloud()
    await backend.json(API, { default_bookmark: "main" })
    await backend.json(`${API}/git/refs`, [ref("refs/heads/main", M), ref("refs/heads/mythical", E3), ref("refs/notes/mythical", NOTES)])
    await backend.json(`${API}/changes`, { items: FEED, next_cursor: "" })
    await backend.route(url => url.pathname.startsWith(`${API}/git/commits/`), route =>
      route.fulfill({ status: 501, json: { status: "error", message: "not implemented" } }))
    // git notes: the notes commit's tree names b2; /contents answers only against the notes commit.
    await backend.route(url => url.pathname === `${API}/contents/` || url.pathname === `${API}/contents/${B2}`, route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get("ref") !== NOTES) return route.fulfill({ status: 404, json: { status: "error", message: "content not found" } })
      return route.fulfill({ json: url.pathname.endsWith(B2)
        ? { name: B2, path: B2, type: "file", encoding: "utf-8", content: NOTE_B2 }
        : [{ name: B2, path: B2, sha: "", type: "file", encoding: "", content: "", size: 0 }] })
    })

    await app.open("/")
    await app.slash(`/history.show ${REPO}`)
    const card = page.locator('[data-kind="history"]').last()
    await expect(card).toContainText("The Stack lands issues in lanes", { timeout: 15_000 })
    await expect(card).toContainText("feat(targets): declare targets")
    await app.closeComposer()
    await app.show(card)
    await app.beat(2500)
  }
})
