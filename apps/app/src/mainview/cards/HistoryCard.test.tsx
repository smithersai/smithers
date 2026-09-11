import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Card } from "@smthrs/rpc/Cards"
import { HistoryCardBody, notesStateLabel, READ_ONLY_NOTE } from "./HistoryCard"

/*
 * The history card renders exactly what its payload states: the empty state
 * is one sentence and one door, the badge is the tree invariant or the honest
 * reason it cannot be checked, and every button carries a registered flow with
 * the repository as its args.
 */

type HistoryCard = Extract<Card, { kind: "history" }>

const card = (payload: HistoryCard["payload"]): HistoryCard => ({
  id: "history-will/flows",
  kind: "history",
  title: "Mythical history · will/flows",
  status: "active",
  createdAt: 1,
  ordinal: 1,
  payload
})

const render = (
  payload: HistoryCard["payload"],
  onRunCommand: (name: string, args?: string) => void = () => {},
  options: { readonly signedOut?: boolean } = {}
): string => renderToStaticMarkup(<HistoryCardBody card={card(payload)} onRunCommand={onRunCommand} signedOut={options.signedOut} />)

const PRESENT: HistoryCard["payload"] = {
  repo: "will/flows",
  defaultBookmark: "main",
  mainCommits: null,
  mythical: {
    state: "present",
    head: "e200000000000000000000000000000000000002",
    mainHead: "3333333333333333333333333333333333333333",
    treeEqual: "unsupported",
    commitCount: 3,
    notes: "absent",
    epics: [{
      sha: "e200000000000000000000000000000000000002",
      title: "02 · Targets",
      merge: true,
      note: null,
      commits: [{ sha: "b200000000000000000000000000000000000002", title: "feat(targets): declare targets", note: null }]
    }]
  }
}

describe("HistoryCard", () => {
  test("the empty state without a count is the short sentence and the bootstrap door carrying the repository", () => {
    const html = render({ repo: "will/flows", defaultBookmark: "main", mainCommits: null, mythical: { state: "absent" } })
    expect(html).toContain('data-testid="history-empty">No mythical history yet.</p>')
    expect(html).not.toContain("commit")
    expect(html).toContain('data-flow="history.bootstrap"')
    expect(html).not.toContain("history.fold")
  })

  /*
   * Spec 03 §6 as amended 2026-09-07: the History view is readable signed out
   * from the mirror's public refs. Its empty state is exactly the one
   * sentence plus the bootstrap door, which signed out is the sign-in door;
   * a present history renders its epics read-only with no write door.
   */
  test("signed out, the empty state is the exact sentence and the bootstrap door reads as the sign-in door", () => {
    const html = render({ repo: "will/flows", defaultBookmark: "main", mainCommits: null, mythical: { state: "absent" } }, () => {}, { signedOut: true })
    expect(html).toContain('data-testid="history-empty">No mythical history yet.</p>')
    expect(html).toContain('data-flow="history.bootstrap"')
    expect(html).toContain("Sign in to bootstrap the mythical history")
    expect(html).not.toContain("history.fold")
  })

  test("signed out, a present history renders its epics read-only: no fold door, no bootstrap door, and the reason in words", () => {
    const html = render(PRESENT, () => {}, { signedOut: true })
    expect(html).toContain('data-testid="history-epic-e200000000000000000000000000000000000002"')
    expect(html).toContain('data-testid="history-commit-b200000000000000000000000000000000000002"')
    expect(html).not.toContain('data-flow="history.fold"')
    expect(html).not.toContain('data-flow="history.bootstrap"')
    expect(html).not.toContain('data-flow="history.amend"')
    expect(html).toContain(`data-testid="history-read-only">${READ_ONLY_NOTE}</span>`)
    expect(html).toContain('data-testid="history-notes-state"')
  })

  test("signed in (and while identity is unknown) the write doors render unchanged", () => {
    for (const options of [{ signedOut: false }, {}]) {
      const html = render(PRESENT, () => {}, options)
      expect(html).toContain('data-flow="history.fold"')
      expect(html).toContain("Fold main into mythical")
      expect(html).not.toContain("history-read-only")
      const empty = render({ repo: "will/flows", defaultBookmark: "main", mainCommits: null, mythical: { state: "absent" } }, () => {}, options)
      expect(empty).toContain(">Bootstrap the mythical history<")
    }
  })

  test("the empty state renders the count clause only when a seam exposed a count", () => {
    expect(render({ repo: "will/flows", defaultBookmark: "main", mainCommits: 214, mythical: { state: "absent" } })).toContain(
      "No mythical history yet. main has 214 commits."
    )
    // One commit reads singular.
    expect(render({ repo: "will/flows", defaultBookmark: "main", mainCommits: 1, mythical: { state: "absent" } })).toContain("main has 1 commit.")
  })

  test("the badge states tree equality against the default bookmark's head, or why it cannot be checked", () => {
    const present = (treeEqual: "equal" | "different" | "unsupported"): HistoryCard["payload"] => ({
      repo: "will/flows",
      defaultBookmark: "main",
      mainCommits: 2,
      mythical: {
        state: "present",
        head: "e200000000000000000000000000000000000002",
        mainHead: "3333333333333333333333333333333333333333",
        treeEqual,
        commitCount: 6,
        notes: "absent",
        epics: [{ sha: "e200000000000000000000000000000000000002", title: "02 · Targets", merge: true, note: null, commits: [] }]
      }
    })
    expect(render(present("equal"))).toContain("tree-equal to main @ 3333333 · 1 epic · 6 commits")
    expect(render(present("different"))).toContain("tree differs from main @ 3333333")
    expect(render(present("unsupported"))).toContain("tree-equal: not available (the mirror does not serve git commits yet)")
    expect(render(present("equal"))).toContain("refs/notes/mythical: not in the mirror&#x27;s ref list")
    expect(render(present("equal"))).toContain('data-flow="history.fold"')
  })

  test("epics list their atomic commits with the note sections the note holds", () => {
    const html = render({
      repo: "will/flows",
      defaultBookmark: "main",
      mainCommits: 2,
      mythical: {
        state: "present",
        head: "e2",
        mainHead: null,
        treeEqual: "unsupported",
        commitCount: 2,
        notes: "read",
        epics: [{
          sha: "e2e2e2e2",
          title: "02 · Targets",
          merge: true,
          note: null,
          commits: [{
            sha: "b2b2b2b2",
            title: "feat(targets): declare targets",
            note: { tried: "a single json file", evidence: null, folded: "9a0f2e1", superseded: null }
          }]
        }]
      }
    })
    expect(html).toContain('data-testid="history-epic-e2e2e2e2"')
    expect(html).toContain('data-testid="history-commit-b2b2b2b2"')
    expect(html).toContain("<dt>Tried</dt><dd>a single json file</dd>")
    expect(html).toContain("<dt>Folded</dt><dd>9a0f2e1</dd>")
    expect(html).not.toContain("<dt>Evidence</dt>")
    expect(html).not.toContain("<dt>Superseded</dt>")
    expect(html).toContain("Fold main into mythical")
  })

  test("an epic stacks its header row above its commits: the nested list is a sibling of the row, and no list item is itself a flex row (mock 13)", () => {
    const html = render({
      repo: "will/flows",
      defaultBookmark: "main",
      mainCommits: 2,
      mythical: {
        state: "present",
        head: "e2",
        mainHead: null,
        treeEqual: "unsupported",
        commitCount: 3,
        notes: "read",
        epics: [{
          sha: "e2e2e2e2",
          title: "02 · Targets",
          merge: true,
          note: { tried: "one file", evidence: null, folded: null, superseded: null },
          commits: [
            { sha: "b2b2b2b2", title: "feat(targets): declare targets", note: null },
            { sha: "b1b1b1b1", title: "docs(targets): what a target is", note: { tried: null, evidence: "green", folded: null, superseded: null } }
          ]
        }]
      }
    })
    // The epic li is a block container; the flex row is a child div that closes before the note and the nested list open.
    const epic = /<li class="history-epic" data-testid="history-epic-e2e2e2e2">(.*?)<\/li><\/ol><div class="history-doors">/.exec(html)
    expect(epic).not.toBeNull()
    const inner = epic![1]!
    expect(inner.startsWith('<div class="world-card-row"><span class="world-card-title">02 · Targets</span>')).toBe(true)
    const headerEnd = inner.indexOf("</div>") + "</div>".length
    const header = inner.slice(0, headerEnd)
    expect(header).toContain("e2e2e2e")
    expect(header).not.toContain("<ol")
    expect(header).not.toContain("<dl")
    const rest = inner.slice(headerEnd)
    expect(rest.startsWith('<dl class="history-note" data-testid="history-note-e2e2e2e2">')).toBe(true)
    expect(rest).toContain('<ol class="history-commits"><li class="history-commit" data-testid="history-commit-b2b2b2b2"><div class="world-card-row">')
    // Neither list item carries the flex-row class, so the header, note and commits stack.
    expect(html).not.toMatch(/<li[^>]*class="[^"]*world-card-row/)
    // A commit's note sits after its own header row, inside its li.
    expect(html).toContain(
      '<li class="history-commit" data-testid="history-commit-b1b1b1b1"><div class="world-card-row"><span class="world-card-title">docs(targets): what a target is</span><span class="world-card-path">b1b1b1b</span></div><dl class="history-note" data-testid="history-note-b1b1b1b1">'
    )
  })

  test("the notes pill states how far the notes read went, so a missing note is never read as absence when the tree was not served", () => {
    expect(notesStateLabel("read")).toBe("refs/notes/mythical")
    expect(notesStateLabel("absent")).toBe("refs/notes/mythical: not in the mirror's ref list")
    expect(notesStateLabel("unread")).toBe("refs/notes/mythical: listed, but the mirror did not serve its notes (none shown)")
    const html = render({
      repo: "will/flows",
      defaultBookmark: "main",
      mainCommits: 2,
      mythical: { state: "present", head: "e2", mainHead: null, treeEqual: "unsupported", commitCount: 1, notes: "unread", epics: [] }
    })
    expect(html).toContain("listed, but the mirror did not serve its notes (none shown)")
  })
})
