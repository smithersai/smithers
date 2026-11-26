// Which tab a step reaches (src/flows/requests.ts): a tab remembers what it dispatched, latest first, and an
// execution's requester is the run it belongs to.
import { Effect, Option } from "effect"
import { describe, expect, test } from "vitest"
import { REMEMBERED, requesterOf, TabRequests } from "./requests.vibe"

const tab = (remembered?: number) => Effect.runSync(Effect.provide(Effect.service(TabRequests), TabRequests.layer(remembered)))

describe("a tab's requests", () => {
  test("names the door each execution came through, and nothing for an execution another tab started", () => {
    const requests = tab()

    Effect.runSync(requests.add("theme-1", "button"))
    Effect.runSync(requests.add("answer-1", "composer"))

    expect(Effect.runSync(requests.doorOf("theme-1"))).toEqual(Option.some("button"))
    expect(Effect.runSync(requests.doorOf("answer-1"))).toEqual(Option.some("composer"))
    expect(Effect.runSync(requests.doorOf("another-tab's"))).toEqual(Option.none())
  })

  test("remembers only its latest dispatches, and one started again is the latest", () => {
    const requests = tab(2)

    Effect.runSync(requests.add("a", "slash"))
    Effect.runSync(requests.add("b", "button"))
    // `a` again: now `b` is the oldest, and the next one forgets it.
    Effect.runSync(requests.add("a", "view"))
    Effect.runSync(requests.add("c", "button"))

    expect(Effect.runSync(requests.doorOf("a"))).toEqual(Option.some("view"))
    expect(Effect.runSync(requests.doorOf("b"))).toEqual(Option.none())
    expect(Effect.runSync(requests.doorOf("c"))).toEqual(Option.some("button"))
  })

  test("each tab remembers its own", () => {
    const first = tab()
    const second = tab()

    Effect.runSync(first.add("theme-1", "button"))

    expect(Effect.runSync(second.doorOf("theme-1"))).toEqual(Option.none())
  })
})

describe("an execution's requester", () => {
  test("is the execution itself for a tab's dispatch, and the answer for the agent's call", () => {
    expect(requesterOf("theme-1")).toBe("theme-1")
    expect(requesterOf("answer-1/chat/Respond@abc:1/call/2.0")).toBe("answer-1")
  })
})


test("the default store retains its real REMEMBERED dispatches and evicts only the oldest", () => {
  expect(REMEMBERED).toBe(1_024)
  const requests = tab()
  for (let i = 0; i < REMEMBERED; i++) Effect.runSync(requests.add(`request:${i}`, "button"))
  for (let i = 0; i < REMEMBERED; i++) expect(Effect.runSync(requests.doorOf(`request:${i}`))).toEqual(Option.some("button"))
  Effect.runSync(requests.add("last", "view"))
  expect(Effect.runSync(requests.doorOf("request:0"))).toEqual(Option.none())
  expect(Effect.runSync(requests.doorOf("request:1"))).toEqual(Option.some("button"))
  expect(Effect.runSync(requests.doorOf("last"))).toEqual(Option.some("view"))
})

test("a retry of a retry keeps its requesting tab, including an agent call inside it", () => {
  const requests = tab()
  const executionId = "retry:retry:original:1/run:2"
  Effect.runSync(requests.add(executionId, "button"))
  expect(requesterOf(executionId)).toBe(executionId)
  expect(Effect.runSync(requests.doorOf(requesterOf(executionId)))).toEqual(Option.some("button"))
  expect(requesterOf(`${executionId}/chat/Respond@abc:1/call/2.0`)).toBe(executionId)
  expect(requesterOf(`${executionId}/run`)).toBe(executionId)
  expect(requesterOf(`${executionId}/run/flow/run/agent@abc:1/call/2.0`)).toBe(executionId)
})
