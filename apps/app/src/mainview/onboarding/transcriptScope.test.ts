import { describe, expect, test } from "bun:test"
import { tutorialTranscript } from "./transcriptScope"

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
