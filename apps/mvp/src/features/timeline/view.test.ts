import { expect, test } from "vitest"
import { formatRelativeTime } from "@smthrs/ui"
import { postgresTime } from "../chat/view"
import { railEntries, railMarkers } from "./view"
import { revisionOf } from "./identity"

test("only chat entries join the rail; recorded states and content identities control summaries", () => {
  const base = { id: "a", role: "user", text: "Find release history", status: "done" }
  const summarized = { ...base, summary: "Find the release history", summaryRevision: revisionOf(base) }
  expect(railEntries([summarized], [])[0]).toMatchObject({ kind: "ask", state: "done", summary: summarized.summary })
  // A summary made from other content, an empty one ("" while the message has none) or none at all shows the label.
  expect(railEntries([{ ...summarized, text: "Changed" }], [])[0]).toMatchObject({ label: "Question 1…", summary: undefined })
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
  expect(railEntries([{ ...message, outputTokens: null }], [])[0]?.tokens).toBeUndefined()
  expect(railEntries([{ ...message, inputTokens: 0, outputTokens: 0 }], [])[0]?.tokens).toBeUndefined()
})

test("pending labels are short, distinct and never borrow question text", () => {
  const messages = [
    { id: "q", role: "user", status: "done", text: "Which release checks failed?" },
    { id: "a", role: "assistant", status: "done", text: "The login test failed", questionId: "q" },
    { id: "q2", role: "user", status: "done", text: "Which release checks failed?" },
    { id: "a2", role: "assistant", status: "done", text: "The login test failed", questionId: "q2" },
  ]
  const labels = railEntries(messages, []).map(row => row.label)
  expect(labels).toEqual(["Question 1…", "Answer 2…", "Question 3…", "Answer 4…"])
  expect(new Set(labels).size).toBe(messages.length)
  expect(labels.join(" ")).not.toContain("release")
})

test("each settled message displays its own current model summary", () => {
  const question = { id: "q", role: "user", status: "done", text: "Which release checks failed?" }
  const answer = { id: "a", role: "assistant", status: "done", text: "The login test failed", questionId: "q" }
  const rows = [question, answer].map((row, index) => ({ ...row, summary: ["Inspecting release failures", "Login regression identified"][index], summaryRevision: revisionOf(row) }))
  expect(railEntries(rows, []).map(({ label, summary }) => ({ label, summary }))).toEqual([
    { label: "Inspecting release failures", summary: "Inspecting release failures" },
    { label: "Login regression identified", summary: "Login regression identified" },
  ])
  expect(railEntries([{ ...rows[1]!, summaryRevision: revisionOf(question) }], [])[0]?.summary).toBeUndefined()
})

test("runs, drafts, TODOs and non-conversation messages never join the rail", () => {
  const question = { id: "q", role: "user", status: "done", text: "Find release history" }
  const answer = { id: "a", role: "assistant", status: "done", text: "Release found", questionId: "q" }
  const statuses = [{ id: "a", state: "done", flow: "chat/Answer" }]
  const drafts = [{ id: "d", answerId: "a", title: "Release notes", createdAt: 1 }]
  const todos = [{ id: "t", title: "Release notes", number: 7, state: "working", prNumber: null, step: "implement", failure: null, updatedAt: "now" }]
  expect(railEntries([question, answer, { ...answer, id: "tool", role: "tool" }, { ...answer, id: "view", role: "view" }], statuses, drafts, todos).map(({ id, kind }) => ({ id, kind })))
    .toEqual([{ id: "q", kind: "ask" }, { id: "a", kind: "answer" }])
  expect(railEntries([], [], drafts, todos)).toEqual([])
})

test("cached generic and stale summaries stay pending", () => {
  const question = { id: "q", role: "user", status: "done", text: "Inspect README.md release steps" }
  for (const summary of ["Reply sent", "Question sent", "  "]) {
    expect(railEntries([{ ...question, summary, summaryRevision: revisionOf(question) }], [])[0]?.label)
      .toBe("Question 1…")
  }
})

test("placeholders distinguish queued, waiting, streaming and failed outcomes", () => {
  const question = { id: "q", role: "user", status: "done", text: "one two three four five six seven eight nine" }
  const answer = { id: "a", questionId: "q", role: "assistant", status: "streaming", text: "" }
  expect(railEntries([question, answer], [])[1]?.label).toBe("Answer 2 · answering")
  expect(railEntries([question, answer], [{ id: "a", state: "needs_you" }])[1]?.label).toBe("Answer 2 · needs you")
  expect(railEntries([question, answer], [{ id: "a", state: "waiting" }])[1]?.label).toBe("Answer 2 · queued")
  expect(railEntries([{ ...question, status: "unsent" }], [])[0]?.label).toBe("Question 1 · not sent")
  expect(railEntries([{ ...answer, status: "failed" }], [])[0]?.label).toBe("Answer 1 · failed")
})

test("credential assignments are scrubbed before excerpts and cached summaries render", () => {
  const question = { id: "q", role: "user", status: "done", text: "Use API_TOKEN=example-secret for deployment" }
  const answer = { id: "a", role: "assistant", status: "done", questionId: "q", text: "done" }
  const todo = { id: "t", title: question.text, number: 7, state: "queued", prNumber: null, step: null, failure: null, updatedAt: "now" }
  const entries = railEntries([{ ...question, summary: question.text, summaryRevision: revisionOf(question) }, answer], [], [], [todo])
  for (const entry of entries) {
    expect(entry.label).not.toContain("example-secret")
    expect(entry.summary ?? "").not.toContain("example-secret")
  }
})

test("timeline times are readable and invalid timestamps are omitted", () => {
  const createdAt = "2026-10-27 04:35:59.478813+00"
  const time = formatRelativeTime(Date.parse("2026-10-27T04:35:59.478Z"))
  const message = { id: "a", role: "assistant", text: "", status: "done", createdAt }
  expect(railEntries([message], [{ id: "a", state: "done", flow: "chat/Answer" }]).map(entry => entry.time)).toEqual([time])
  expect(railEntries([{ ...message, createdAt: "invalid" }], [])[0]?.time).toBeUndefined()
  const todo = { id: "t", title: "Ship", number: 1, state: "done", prNumber: null, step: null, failure: null, updatedAt: createdAt }
  expect(railEntries([], [], [], [todo])).toEqual([])
})


test("phase markers preserve boundaries and scrub cached content", () => {
  const row = { id: "q", role: "user", status: "done", text: "Release", phase: JSON.stringify({ title: "Fixing API_TOKEN=example-secret", summary: "Fixed API_TOKEN=example-secret", closed: false, covered: 1 }) }
  const answer = { id: "a", questionId: "q", role: "assistant", status: "done", text: "Released" }
  const markers = railMarkers([row, answer, { ...row, id: "none", phase: "" }], "phase")
  expect(markers).toHaveLength(1)
  expect(markers[0]).toMatchObject({ id: "phase:q", start: "q", closed: false })
  expect(JSON.stringify(markers)).not.toContain("example-secret")
})

test("a covered phase stands at its starting message; missing, malformed and unsent coverage adds nothing", () => {
  const mark = JSON.stringify({ title: "Researching issue 450", summary: "Traced the flaky test", closed: true, covered: 1 })
  const base = { role: "user", status: "done", text: "Find it" }
  const markers = railMarkers([
    { ...base, id: "plain", phase: "" },
    { id: "plain-answer", questionId: "plain", role: "assistant", status: "done", text: "Recorded" },
    { ...base, id: "broken", phase: "{" },
    { id: "broken-answer", questionId: "broken", role: "assistant", status: "done", text: "Recorded" },
    { ...base, id: "kept", phase: mark },
    { id: "answer", questionId: "kept", role: "assistant", status: "done", text: "Found it" },
    { ...base, id: "draft", status: "unsent", phase: mark },
  ], "phase")
  expect(markers.map(marker => [marker.id, marker.start, marker.end, marker.title])).toEqual([
    ["phase:kept", "kept", "answer", "Researching issue 450"],
  ])
})


test("phase and arc markers carry the last covered answer, excluding the unsummarized tail", async () => {
  const { railMarkers } = await import("./view")
  const phase = (covered: number) => JSON.stringify({ title: "Research", summary: "Read the evidence", closed: true, covered })
  const messages = Array.from({ length: 6 }, (_, index) => [
    { id: `q${index}`, role: "user", status: "done", text: "Question", phase: index === 0 || index === 2 ? phase(2) : "", arc: index === 0 ? phase(2) : "" },
    { id: `a${index}`, questionId: `q${index}`, role: "assistant", status: "done", text: "Answer" },
  ]).flat()
  expect(railMarkers(messages, "phase").map(({ start, end }) => [start, end])).toEqual([["q0", "a1"], ["q2", "a3"]])
  expect(railMarkers(messages, "arc").map(({ start, end }) => [start, end])).toEqual([["q0", "a3"]])
  expect(railMarkers([{ ...messages[0]!, phase: phase(999) }], "phase")).toEqual([])
})


test("a phase or arc without a complete covered exchange never draws a partial marker", () => {
  const mark = (covered: number) => JSON.stringify({ title: "Research", summary: "Evidence", closed: true, covered })
  const question = { id: "q", role: "user", status: "done", text: "Question" }
  const answer = { id: "a", questionId: "q", role: "assistant", status: "done", text: "Answer" }
  for (const covered of [0, -1, 0.5, 999]) {
    expect(railMarkers([{ ...question, phase: mark(covered), arc: mark(covered) }, answer], "phase")).toEqual([])
    expect(railMarkers([{ ...question, phase: mark(1), arc: mark(covered) }, answer], "arc")).toEqual([])
  }
  expect(railMarkers([{ ...question, phase: mark(1), arc: mark(1) }], "phase")).toEqual([])
  expect(railMarkers([{ ...question, phase: mark(1), arc: mark(1) }], "arc")).toEqual([])
})
