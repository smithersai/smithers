import { describe, expect, test } from "bun:test"
import { tutorialTranscript, workspaceTranscript } from "./transcriptScope"

describe("tutorial transcript", () => {
  test("allows lesson origins and tutorial chat, excluding preexisting workspace chrome and legacy unscoped records", () => {
    const cards = ["account", "secrets", "settings", "world", "runs", "repo-home", "repo-onboarding", "future-workspace-card"]
      .map(kind => ({ id: kind, kind, payload: {} }))
    const lesson = { id: "choose", kind: "repository-choice", payload: {} }
    const practice = { id: "practice-issue-3", kind: "issue", payload: {} }
    const chat = { id: "chat-home", kind: "repo-home", payload: {} }
    expect(tutorialTranscript([...cards, lesson, practice, chat], {
      account: { step: 1, source: "lesson" },
      choose: { step: 11, source: "lesson", owned: true },
      "chat-home": { step: 12, source: "chat", owned: true },
    })).toEqual([lesson, practice, chat])
  })

  test("an unrecorded file is workspace-owned even though a lesson can produce the same kind", () => {
    const cards = [{ id: "workspace-file", kind: "file", payload: {} }, { id: "lesson-file", kind: "file", payload: {} }]
    expect(tutorialTranscript(cards, { "lesson-file": { step: 8, source: "lesson", owned: true } })).toEqual([cards[1]!])
  })
})

test("the terminal workspace keeps the selected repository and omits practice or another route's cards", () => {
  const cards = [
    { kind: "repo-home", payload: { repo: "old/repo" } },
    { kind: "issue", payload: { repo: "practice:smithersai/hello-server" } },
    { kind: "repo-home", payload: { repo: "acme/api" } },
    { kind: "account", payload: {} },
  ]
  expect(workspaceTranscript(cards, "acme/api")).toEqual(cards.slice(2))
})


test("finished workspaces exclude tutorial artifacts even without a repo selection or a practice repo payload", () => {
  const cards = [
    { id: "practice-issue-3", payload: { repo: "smithersai/hello-server" } },
    { id: "issue-flows", payload: { repo: "practice:smithersai/hello-server" } },
    { id: "run", payload: { input: { liveTutorial: { operation: "research" } } } },
    { id: "flow-run-practice-fix-hello-3", payload: {} },
    { id: "home", payload: { repo: "acme/api" } },
    { id: "real-run", payload: { repo: "acme/api", input: { _librarian: { kind: "wiki" } } } },
    { id: "chat", payload: {} },
  ]
  expect(workspaceTranscript(cards, null)).toEqual(cards.slice(4))
  expect(workspaceTranscript(cards, "acme/api")).toEqual(cards.slice(4))
})
