import { describe, expect, test } from "vitest"
import {
  NOTIFICATION_POLICY_EVENT,
  notificationPolicyDeclaration,
  notificationPolicyDefault,
  notificationPolicyRecord,
  type NotificationPolicyRequest,
  NotificationPolicyRequestSchema,
  notificationPolicyResult,
  notificationPolicySuperseded,
  notifies
} from "../src/NotificationPolicy.ts"

/*
 * The repository notification policy contract (mvp.md §6.17): which declaration
 * a projection makes, and how the app treats a policy's answer. Access is checked
 * after the policy selects, and every fallback delivers the default and says why.
 */

const request: NotificationPolicyRequest = {
  repo: "owner/repo",
  event: { kind: "needs_you", entryId: "entry-1", todo: 7 },
  owner: "ada",
  candidates: ["ada", "ben", "cy"],
  defaults: ["cy", "ada"]
}

describe("notificationPolicyDeclaration", () => {
  const route = (flow: string | [string, ...Array<string>]) => ({ event: NOTIFICATION_POLICY_EVENT, flow })
  const unrelated = { event: "todo.created", flow: "triage" }

  test("no notification.route row keeps the built-in default", () => {
    expect(notificationPolicyDeclaration({ on: [] })).toEqual({ kind: "none" })
    expect(notificationPolicyDeclaration({ on: [unrelated] })).toEqual({ kind: "none" })
  })

  test("one row naming one flow declares that flow, whether written as a string or a one-item list", () => {
    expect(notificationPolicyDeclaration({ on: [unrelated, route("notification-policy")] })).toEqual({
      kind: "flow",
      flowId: "notification-policy"
    })
    expect(notificationPolicyDeclaration({ on: [route(["router"])] })).toEqual({ kind: "flow", flowId: "router" })
  })

  test("two rows, several flows or a blank flow id is ambiguous, never a guess", () => {
    expect(notificationPolicyDeclaration({ on: [route("a"), route("b")] })).toEqual({ kind: "ambiguous" })
    expect(notificationPolicyDeclaration({ on: [route(["a", "b"])] })).toEqual({ kind: "ambiguous" })
    expect(notificationPolicyDeclaration({ on: [route("   ")] })).toEqual({ kind: "ambiguous" })
  })
})

describe("NotificationPolicyRequestSchema", () => {
  test("accepts a request whose built-in audience can read the event", () => {
    expect(NotificationPolicyRequestSchema.parse(request)).toEqual(request)
  })

  test("refuses a built-in audience that includes someone who cannot read the event", () => {
    const widened = NotificationPolicyRequestSchema.safeParse({ ...request, defaults: ["ada", "eve"] })
    expect(widened.success).toBe(false)
    expect(widened.error?.issues.map((issue) => issue.message)).toEqual([
      "The built-in audience is always people who can read the event"
    ])
  })
})

describe("notificationPolicyDefault", () => {
  test("tells the built-in audience in candidate order and records nothing", () => {
    const outcome = notificationPolicyDefault(request)
    expect(outcome).toEqual({ recipients: ["ada", "cy"], stamp: { source: "default" }, withheld: [], quiet: false })
    expect(notificationPolicyRecord(outcome)).toBeUndefined()
  })

  test("a fallback still delivers the default and records its reason", () => {
    const outcome = notificationPolicyDefault(request, "policy-failed")
    expect(outcome.recipients).toEqual(["ada", "cy"])
    expect(notificationPolicyRecord(outcome)).toEqual({ source: "default", reason: "policy-failed" })
  })

  test("a repeated candidate is told once", () => {
    expect(notificationPolicyDefault({ ...request, candidates: ["ada", "ada", "cy"] }).recipients).toEqual([
      "ada",
      "cy"
    ])
  })
})

describe("notificationPolicyResult", () => {
  test("keeps the policy's selection in candidate order, deduplicated, and honours quiet", () => {
    const outcome = notificationPolicyResult(request, { recipients: ["cy", "ben", "cy"], handling: { quiet: true } })
    expect(outcome).toEqual({ recipients: ["ben", "cy"], stamp: { source: "policy" }, withheld: [], quiet: true })
    expect(notificationPolicyRecord(outcome)).toEqual({ source: "policy" })
  })

  test("withholds and counts a selected recipient who cannot read the event", () => {
    const outcome = notificationPolicyResult(request, { recipients: ["eve", "ben", "eve", "mal"] })
    expect(outcome).toEqual({
      recipients: ["ben"],
      stamp: { source: "policy", withheld: 2 },
      withheld: ["eve", "mal"],
      quiet: false
    })
    expect(notifies(outcome, "ben")).toBe(true)
    expect(notifies(outcome, "eve")).toBe(false)
  })

  test("an empty selection is an answer: nobody is told and nothing falls back", () => {
    expect(notificationPolicyResult(request, { recipients: [] }).recipients).toEqual([])
  })

  test.each([
    ["no recipients key", {}],
    ["an extra key", { recipients: ["ada"], note: "secret" }],
    ["a display name", { recipients: ["Ada Lovelace"] }],
    ["an extra handling flag", { recipients: ["ada"], handling: { urgent: true } }],
    ["prose", "tell ada"]
  ])("a malformed answer (%s) falls back to the default and says so", (_label, output) => {
    expect(notificationPolicyResult(request, output)).toEqual({
      recipients: ["ada", "cy"],
      stamp: { source: "default", reason: "policy-malformed" },
      withheld: [],
      quiet: false
    })
  })
})

describe("notificationPolicySuperseded", () => {
  test("tells nobody and records that the answer was superseded", () => {
    const outcome = notificationPolicySuperseded()
    expect(outcome.recipients).toEqual([])
    expect(notifies(outcome, "ada")).toBe(false)
    expect(notificationPolicyRecord(outcome)).toEqual({ source: "default", reason: "policy-superseded" })
  })
})

describe("notificationPolicyRecord", () => {
  test("a default stamp carrying a withheld count is still recorded", () => {
    const stamp = { source: "default", withheld: 1 } as const
    expect(notificationPolicyRecord({ recipients: [], stamp, withheld: ["eve"], quiet: false })).toEqual(stamp)
  })
})
