import { describe, expect, test } from "bun:test"
import { tutorialTranscript, workspaceTranscript } from "./transcriptScope"

describe("tutorial transcript", () => {
  test("drops a repository route's welcome and home cards replayed from the shared store", () => {
    const cards = [
      { id: "repo-home-smithersai/smithers", kind: "repo-home" },
      { id: "welcome", kind: "repo-onboarding" },
      { id: "choose", kind: "repository-choice" },
      { id: "issues", kind: "issues" }
    ]
    expect(tutorialTranscript(cards).map((card) => card.id)).toEqual(["choose", "issues"])
  })

  test("keeps every card when none came from a repository route", () => {
    const cards = [{ id: "a", kind: "repository-choice" }, { id: "b", kind: "file" }]
    expect(tutorialTranscript(cards)).toEqual(cards)
  })
})

test("an explicitly requested Home card from chat is not mistaken for repository entry chrome", () => {
  const cards = [{ id: "entry-home", kind: "repo-home" }, { id: "chat-home", kind: "repo-home" }]
  expect(tutorialTranscript(cards, new Set(["chat-home"]))).toEqual([cards[1]!])
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
