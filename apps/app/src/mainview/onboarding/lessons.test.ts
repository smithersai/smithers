import { expect, test } from "bun:test"
import { GUIDE_RESERVED_KEYS, GUIDE_STAGES, lessonMessage } from "./lessons"
// The explicit extension: on a case-insensitive filesystem "./reel" can resolve to Reel.tsx.
import { REEL_BUTTON } from "./reel.ts"

test("every lesson letter is unique, single, and clear of the shell's reserved keys", () => {
  const keys: Array<string> = []
  for (const lesson of GUIDE_STAGES) {
    if (lesson.kind !== "do") continue
    for (const action of [...lesson.actions, ...(lesson.secondary === undefined ? [] : [lesson.secondary])]) {
      if (action.key === "⌘K") continue // the ⌘K lesson teaches the chord itself
      expect(action.key).toMatch(/^[A-Z]$/)
      keys.push(action.key)
    }
  }
  keys.push(REEL_BUTTON.key)
  expect(new Set(keys).size).toBe(keys.length)
  for (const reserved of GUIDE_RESERVED_KEYS) expect(keys).not.toContain(reserved)
  expect(REEL_BUTTON.key).toBe("E")
})

test("no user-visible copy says workflow, PR, landing request, or type /", () => {
  for (const lesson of GUIDE_STAGES) {
    const copy = [lesson.message, lesson.kind === "say" ? lesson.more ?? "" : "", lesson.kind === "do" ? [lesson.instruction, lesson.success ?? "", ...lesson.actions.map(action => action.label)].join(" ") : ""].join(" ")
    expect(copy).not.toMatch(/workflow|landing request|\bPR\b|type \//i)
  }
})

test("the terminal line follows the escape hatch taken, and {repo} is the user's repository", () => {
  const last = GUIDE_STAGES.length - 1
  expect(lessonMessage(last, { repo: "acme/api" })).toContain("pick one of acme/api's issues")
  expect(lessonMessage(last, { declined: ["login"] })).toBe("You're set. Log in from Account whenever you want to bring your own repository.")
  expect(lessonMessage(last, { declined: ["install"] })).toBe("Install the GitHub App from Account when you're ready, and I'll start your Wiki and history.")
})
