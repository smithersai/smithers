// The API's routes and cursors (src/core/wire.vibe, worker/Http.vibe) and the names the sequencer gives its replies
// and the budget its days: plain functions the workerd suites reach only through HTTP.
import { describe, expect, it } from "vitest"
import { conversationPath, MAX_CONVERSATION, routeOf } from "../src/core/wire.vibe"
import { failureOf } from "../src/web/view.vibe"
import { afterOf } from "../worker/Http.vibe"
import { dayOf, REASONS } from "../worker/Reply.vibe"
import { replyIdOf } from "../worker/Sequencer.vibe"

describe("the API's routes", () => {
  it("round-trips any conversation id as one path segment", () => {
    for (const id of ["home", "a b", "ü/ß?#%", "x".repeat(MAX_CONVERSATION)]) {
      expect(routeOf("GET", conversationPath(id))).toEqual({ kind: "read", conversation: id })
      expect(routeOf("POST", `${conversationPath(id)}/posts`)).toEqual({ kind: "post", conversation: id })
      expect(routeOf("GET", `${conversationPath(id)}/events`)).toEqual({ kind: "events", conversation: id })
    }
  })

  it("refuses other methods, paths, empty, malformed and overlong ids", () => {
    expect(routeOf("POST", "/api/conversations/home")).toBeUndefined()
    expect(routeOf("GET", "/api/conversations/home/posts")).toBeUndefined()
    expect(routeOf("GET", "/api/conversations/home/events/more")).toBeUndefined()
    expect(routeOf("GET", "/api/conversations/")).toBeUndefined()
    expect(routeOf("GET", "/api/conversations/%E0%A4%A")).toBeUndefined()
    expect(routeOf("GET", `/api/conversations/${"x".repeat(MAX_CONVERSATION + 1)}`)).toBeUndefined()
    expect(routeOf("GET", "/api/other/home")).toBeUndefined()
  })

  it("reads a cursor only as a safe nonnegative integer, zero when absent", () => {
    const after = (query: string) => afterOf(new URL(`https://x.test/p${query}`))
    expect(after("")).toBe(0)
    expect(after("?after=12")).toBe(12)
    for (const bad of ["-1", "1.5", "01", "1e3", "x", "", "9007199254740992"]) expect(after(`?after=${bad}`), bad).toBeUndefined()
  })
})

describe("names and words", () => {
  it("gives each post exactly one reply id and each UTC day its budget", () => {
    expect(replyIdOf("m7")).toBe("r7")
    expect(dayOf(Date.UTC(2026, 10, 7, 23, 59, 59))).toBe("2026-11-07")
    expect(dayOf(Date.UTC(2026, 10, 8, 0, 0, 0))).toBe("2026-11-08")
  })

  it("shows a failed answer's reason, or that it failed when it has none", () => {
    expect(failureOf(REASONS.budget)).toBe(REASONS.budget)
    expect(failureOf("failed")).toBe("Answer failed")
    expect(failureOf("")).toBe("Answer failed")
  })
})
