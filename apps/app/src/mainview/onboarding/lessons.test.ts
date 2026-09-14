import { expect, test } from "bun:test"
import { GUIDE_RESERVED_KEYS, GUIDE_STAGES, lessonMessage, lessonVisible } from "./lessons"
// The explicit extension: on a case-insensitive filesystem "./reel" can resolve to Reel.tsx.
import { REEL_BUTTON } from "./reel.ts"
import { initialGuide, type GuideState } from "../state/AppState"

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
  expect(lessonMessage(last, { declined: ["login"] })).toBe("You're set. Log in from Account whenever you want to chat or bring your own repository.")
  expect(lessonMessage(last, { declined: ["install"] })).toBe("Install the GitHub App from Account when you're ready, and I'll start your Wiki and history.")
})

test("declining sign-in teaches commands and offers finishing without sending a chat turn", () => {
  for (const touch of [false, true]) {
    const message = lessonMessage(13, { declined: ["login"] }, touch)
    expect(message).toContain(touch ? "Tap Chat" : "Press C")
    expect(message).toContain("Sign in from Account to send a message")
    expect(message).toContain("finish this tutorial without sending anything")
  }
  const lesson = GUIDE_STAGES[13]
  expect(lesson?.kind === "do" ? lesson.secondary : undefined).toEqual({ label: "Finish tutorial", key: "f", flow: "onboarding.act", args: "finish" })
})


test("declined installation and login do not create history for skipped lessons", () => {
  expect(lessonVisible(11, { declined: ["login"] })).toBe(false)
  expect(lessonVisible(12, { declined: ["login"] })).toBe(false)
  expect(lessonVisible(12, { declined: ["install"] })).toBe(false)
  expect(lessonVisible(13, { declined: ["login"] })).toBe(true)
  expect(lessonMessage(10, { declined: ["practice"] })).not.toContain("Everything you just did")
})


test("deferred background setup never claims Wiki or history were launched", () => {
  const message = lessonMessage(14, { repo: "will/demo", declined: ["background"] })
  expect(message).toContain("ask Chat")
  expect(message).toContain("later")
  expect(message).toContain("will/demo")
  expect(message).not.toMatch(/land soon|running|started/)
})

test("the terminal promise follows the current attempts, not a failed earlier scope or playthrough", () => {
  const entry = { kind: "history" as const, repo: "will/demo", startedAt: 1, phase: "failed" as const,
    scope: JSON.stringify(["will/demo", null, null, null, null, 0]) }
  const guide: GuideState = { ...initialGuide(), repo: "will/demo", librarianLaunches: [entry] }
  expect(lessonMessage(14, guide)).not.toContain("land soon")
  expect(lessonMessage(14, { ...guide, playthrough: 1 })).toContain("land soon")
  expect(lessonMessage(14, { ...guide, librarianLaunches: [entry, { ...entry, phase: "started", scope: JSON.stringify(["will/demo", "repo", "workspace", "branch", "will", 0]) }] })).toContain("land soon")
})
