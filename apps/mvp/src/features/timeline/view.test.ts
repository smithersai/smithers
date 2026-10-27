import { expect, test } from "vitest"
import { formatRelativeTime } from "@smthrs/ui"
import { postgresTime } from "../chat/view"
import { railEntries } from "./view"
import { revisionOf } from "./identity"

test("only chat entries join the rail; recorded states and content identities control summaries", () => {
  const base = { id: "a", role: "user", text: "Find release history", status: "done" }
  const summarized = { ...base, summary: "Find the release history", summaryRevision: revisionOf(base) }
  expect(railEntries([summarized], [])[0]).toMatchObject({ kind: "ask", state: "done", summary: summarized.summary })
  // A summary made from other content, an empty one ("" while the message has none) or none at all shows the label.
  expect(railEntries([{ ...summarized, text: "Changed" }], [])[0]).toMatchObject({ label: "Changed", summary: undefined })
  expect(railEntries([{ ...summarized, summary: "", summaryRevision: "" }], [])[0]?.summary).toBeUndefined()
  expect(railEntries([{ ...summarized, summary: null, summaryRevision: null }], [])[0]?.summary).toBeUndefined()
  expect(railEntries([{ ...base, role: "view" }], [])).toEqual([])
  for (const [status, state] of [["streaming", "working"], ["failed", "failed"], ["unsent", "failed"], ["queued", "queued"], ["done", "done"]]) {
    expect(railEntries([{ ...summarized, status: status!, role: "assistant" }], [])[0]).toMatchObject({ state, kind: "answer" })
  }
  expect(railEntries([base, { ...base, status: "unsent" }], []).map(entry => entry.id)).toEqual(["a", "unsent:a"])
  expect(railEntries([base], [{ id: "a", state: "needs_you" }])[0]?.state).toBe("waiting")
  expect(railEntries([base], [{ id: "a", state: "waiting" }])[0]?.state).toBe("queued")
  expect(railEntries([base], [{ id: "other", state: "needs_you" }])[0]?.state).toBe("done")
})

test("timeline carries recorded evidence without inventing missing usage", () => {
  const message = { id: "evidence", role: "assistant", text: "Done", status: "done", createdAt: "2026-10-20 19:58:00.123456+00", inputTokens: 200, outputTokens: 40 }
  expect(railEntries([message], [])[0]).toMatchObject({ actor: "Smithers", time: formatRelativeTime(postgresTime(message.createdAt)!), tokens: 240 })
  expect(railEntries([{ ...message, inputTokens: null }], [])[0]?.tokens).toBeUndefined()
  expect(railEntries([{ ...message, inputTokens: 0, outputTokens: 0 }], [])[0]?.tokens).toBeUndefined()
})

test("a question identifies its subject before a summary arrives", () => {
  const question = { id: "q", role: "user", status: "done", text: "Which release checks failed?" }
  expect(railEntries([question], [])[0]?.label).toBe("Which release checks failed?")
})

test("a reply identifies the recorded question and its outcome without copying assistant content", () => {
  const question = { id: "q", role: "user", status: "done", text: "Which release checks failed?" }
  const answer = { id: "a", questionId: "q", role: "assistant", status: "done", text: "private answer content" }
  expect(railEntries([question, answer], [])[1]?.label).toBe("Which release checks failed? · answered")
  expect(railEntries([question, { ...answer, status: "failed" }], [])[1]?.label).toBe("Which release checks failed? · failed")
})

test("a reply never borrows a neighboring question's subject", () => {
  const entries = railEntries([
    { id: "q", role: "user", status: "done", text: "Unrelated question" },
    { id: "a", questionId: "missing", role: "assistant", status: "streaming", text: "" },
  ], [])
  expect(entries[1]?.label).toBe("a · answering")
})

test("a run names its recorded flow and result", () => {
  const answer = { id: "a", role: "assistant", status: "done", text: "" }
  expect(railEntries([answer], [{ id: "a", state: "done", flow: "chat/Answer" }]).find(entry => entry.kind === "flow"))
    .toMatchObject({ id: "run:a", label: "chat/Answer · completed", state: "done" })
})

test("a TODO draft names the object and stays in its own conversation", () => {
  const messages = [{ id: "a", role: "assistant", status: "done", text: "" }]
  const drafts = [
    { id: "d", answerId: "a", title: "README release notes", createdAt: 1 },
    { id: "elsewhere", answerId: "other", title: "Private other branch", createdAt: 2 },
  ]
  expect(railEntries(messages, [], drafts).filter(entry => entry.kind === "tool"))
    .toEqual([expect.objectContaining({ id: "todo:d", label: "README release notes · draft" })])
})

test("cached generic and stale summaries fall back to recorded objects", () => {
  const question = { id: "q", role: "user", status: "done", text: "Inspect README.md release steps" }
  for (const summary of ["Reply sent", "Question sent", "  "]) {
    expect(railEntries([{ ...question, summary, summaryRevision: revisionOf(question) }], [])[0]?.label)
      .toBe(question.text)
  }
})

test("fallback labels bound long subjects and distinguish queued, waiting and failed outcomes", () => {
  const question = { id: "q", role: "user", status: "done", text: "one two three four five six seven eight nine" }
  expect(railEntries([question], [])[0]?.label).toBe("one two three four five six seven eight…")
  const answer = { id: "a", questionId: "q", role: "assistant", status: "streaming", text: "" }
  expect(railEntries([question, answer], [{ id: "a", state: "needs_you" }])[1]?.label).toContain(" · needs you")
  expect(railEntries([question, answer], [{ id: "a", state: "waiting" }])[1]?.label).toContain(" · queued")
  expect(railEntries([{ ...question, status: "unsent" }], [])[0]?.label).toContain(" · not sent")
})

test("a committed TODO shows its title, pull request and recorded outcome", () => {
  const todo = { id: "t", title: "Fix README link", number: 7, state: "in_review", prNumber: 4435, step: null, failure: null, updatedAt: "2026-10-23" }
  expect(railEntries([], [], [], [todo])).toEqual([
    expect.objectContaining({ id: "todo:t", kind: "tool", label: "Fix README link · PR #4435 · in review", state: "waiting" }),
  ])
})

test("every TODO state and failed run keeps its object", () => {
  const todo = { id: "t", title: "README.md", number: 7, prNumber: null, step: null, failure: null, updatedAt: "now" }
  for (const [state, shown] of [["queued", "queued"], ["working", "working"], ["failed", "failed"], ["merged", "done"], ["dropped", "done"]]) {
    expect(railEntries([], [], [], [{ ...todo, state: state! }])[0]).toMatchObject({ state: shown, label: `README.md · T7 · ${state}` })
  }
  expect(railEntries([], [], [], [{ ...todo, state: "failed", failure: "implement" }])[0]?.label).toBe("README.md · T7 · implement failed")
  expect(railEntries([{ id: "a", role: "assistant", text: "", status: "failed" }], [{ id: "a", state: "failed", flow: "release/check" }])[1]?.label).toBe("release/check · failed")
})

test("settled TODO outcomes win over a retained execution step", () => {
  const todo = { id: "t", title: "README.md", number: 7, prNumber: 4435, step: "await", failure: null, updatedAt: "now" }
  for (const state of ["merged", "dropped", "in_review"]) {
    expect(railEntries([], [], [], [{ ...todo, state }])[0]?.label)
      .toBe(`README.md · PR #4435 · ${state.replaceAll("_", " ")}`)
  }
})

test("credential assignments are scrubbed before excerpts and cached summaries render", () => {
  const question = { id: "q", role: "user", status: "done", text: "Use API_TOKEN=example-secret for deployment" }
  const answer = { id: "a", role: "assistant", status: "done", questionId: "q", text: "done" }
  const todo = { id: "t", title: question.text, number: 7, state: "queued", prNumber: null, step: null, failure: null, updatedAt: "now" }
  const entries = railEntries([{ ...question, summary: question.text, summaryRevision: revisionOf(question) }, answer], [], [], [todo])
  for (const entry of entries) {
    expect(entry.label).not.toContain("example-secret")
    expect(entry.label).toContain("[REDACTED]")
    expect(entry.summary ?? "").not.toContain("example-secret")
  }
})

test("draft entries follow transcript creation order after reload", () => {
  const messages = [{ id: "a", role: "assistant", status: "done", text: "" }]
  const drafts = [
    { id: "newer", answerId: "a", title: "Newer", createdAt: 20 },
    { id: "older", answerId: "a", title: "Older", createdAt: 10 },
  ]
  expect(railEntries(messages, [], drafts).filter(entry => entry.kind === "tool").map(entry => entry.id))
    .toEqual(["todo:older", "todo:newer"])
})


test("long question subjects stay bounded in the navigation label", () => {
  const text = "release-" + "x".repeat(80)
  expect(railEntries([{ id: "q", role: "user", status: "done", text }], [])[0]?.label)
    .toBe(`${text.slice(0, 79)}…`)
})

test("an untitled draft remains identifiable and an active TODO names its step", () => {
  const messages = [{ id: "a", role: "assistant", status: "done", text: "" }]
  expect(railEntries(messages, [], [{ id: "draft-7", answerId: "a", title: "  ", createdAt: 1 }])[1]?.label)
    .toBe("draft-7 · draft")
  const todo = { id: "t", title: "  ", number: 7, state: "working", prNumber: null, step: "implement", failure: null, updatedAt: "now" }
  expect(railEntries([], [], [], [todo])[0]).toMatchObject({ state: "working", label: "T7 · T7 · implement" })
})

 test("timeline times are readable and invalid timestamps are omitted", () => {
  const createdAt = "2026-10-27 04:35:59.478813+00"
  const time = formatRelativeTime(Date.parse("2026-10-27T04:35:59.478Z"))
  const message = { id: "a", role: "assistant", text: "", status: "done", createdAt }
  expect(railEntries([message], [{ id: "a", state: "done", flow: "chat/Answer" }]).map(entry => entry.time)).toEqual([time, time])
  expect(railEntries([{ ...message, createdAt: "invalid" }], [])[0]?.time).toBeUndefined()
  const todo = { id: "t", title: "Ship", number: 1, state: "done", prNumber: null, step: null, failure: null, updatedAt: createdAt }
  expect(railEntries([], [], [], [todo])[0]?.time).toBe(time)
})
