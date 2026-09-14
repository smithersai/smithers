import { expect, test } from "bun:test"
import { GUIDE_RESERVED_KEYS, GUIDE_STAGES, lessonMessage, lessonVisible } from "./lessons"
// The explicit extension: on a case-insensitive filesystem "./reel" can resolve to Reel.tsx.
import { REEL_BUTTON } from "./reel.ts"

test("each lesson's shortcuts are unique, single, lowercase, and clear of the shell's reserved keys", () => {
  for (const lesson of GUIDE_STAGES) {
    const keys: Array<string> = []
    const actions = lesson.kind === "do"
      ? [...lesson.actions, ...(lesson.secondary === undefined ? [] : [lesson.secondary])]
      : lesson.optionalAction === undefined ? [] : [lesson.optionalAction]
    for (const action of actions) {
      if (action.key === "c" && "flow" in action && action.flow === "chat.open") continue // the Chat lesson teaches the global control itself
      expect(action.key).toMatch(/^[a-z]$/)
      keys.push(action.key)
    }
    expect(new Set(keys).size).toBe(keys.length)
    for (const reserved of GUIDE_RESERVED_KEYS) expect(keys).not.toContain(reserved)
  }
  expect(REEL_BUTTON.key).toBe("e")
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


test("declined installation and login do not create history for skipped lessons", () => {
  expect(lessonVisible(11, { declined: ["login"] })).toBe(false)
  expect(lessonVisible(12, { declined: ["login"] })).toBe(false)
  expect(lessonVisible(12, { declined: ["install"] })).toBe(false)
  expect(lessonVisible(13, { declined: ["login"] })).toBe(true)
  expect(lessonMessage(10, { declined: ["practice"] })).not.toContain("Everything you just did")
})
