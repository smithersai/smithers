import { describe, expect, it } from "vitest"
import { shapeOf, ShapeSync } from "./sync"

// When a page's shapes are up to date (e2e/sync.ts), as e2e/health.spec.ts waits for: by Electric's protocol, not a
// sleep.

const ORIGIN = "https://smithers.example"
const UP = { "electric-up-to-date": "" }

describe("shapeOf", () => {
  it("names a shape by its path and the parameters that choose its rows, whatever its place in the log", () => {
    const first = shapeOf(`${ORIGIN}/api/shapes/items?repository=smithersai%2Fsmithers&offset=-1`)
    const later = shapeOf(`${ORIGIN}/api/shapes/items?offset=12_3&handle=h1&live=true&cursor=9&repository=smithersai%2Fsmithers`)
    expect(first).toBe("/api/shapes/items?repository=smithersai%2Fsmithers")
    expect(later).toBe(first)
    expect(shapeOf(`${ORIGIN}/api/shapes/b?z=1&a=2&m=3&offset=-1`)).toBe("/api/shapes/b?a=2&m=3&z=1")
    expect(shapeOf(`${ORIGIN}/api/shapes/b?b=1&b=0`)).toBe("/api/shapes/b?b=1&b=0")
    expect(shapeOf(`${ORIGIN}/api/shapes/messages?offset=-1`)).toBe("/api/shapes/messages")
  })

  it("is undefined for any request that isn't a shape's", () => {
    expect(shapeOf(`${ORIGIN}/api/auth/session`)).toBeUndefined()
    expect(shapeOf(`${ORIGIN}/smithersai/smithers`)).toBeUndefined()
  })
})

describe("ShapeSync", () => {
  it("holds a shape behind from its first request until an answer says it is up to date", () => {
    const sync = new ShapeSync()
    sync.requested(`${ORIGIN}/api/shapes/items?offset=-1`)
    sync.requested(`${ORIGIN}/api/auth/session`)
    expect(sync.count).toBe(1)
    expect(sync.behind()).toEqual(["/api/shapes/items"])
    sync.answered(`${ORIGIN}/api/shapes/items?offset=-1`, 200, {})
    expect(sync.behind()).toEqual(["/api/shapes/items"])
    sync.answered(`${ORIGIN}/api/shapes/items?offset=0_0&handle=h`, 200, UP)
    expect(sync.behind()).toEqual([])
    // A later request of a settled shape, a live poll, keeps it settled.
    sync.requested(`${ORIGIN}/api/shapes/items?offset=0_0&handle=h&live=true`)
    expect(sync.behind()).toEqual([])
  })

  it("keeps a shape behind through a 5xx and Electric's 409, and settles one the server refuses", () => {
    const sync = new ShapeSync()
    sync.answered(`${ORIGIN}/api/shapes/items?offset=-1`, 500, {})
    sync.answered(`${ORIGIN}/api/shapes/pulls?offset=-1`, 409, {})
    sync.answered(`${ORIGIN}/api/shapes/reviews?offset=-1`, 401, {})
    sync.answered(`${ORIGIN}/api/auth/session`, 200, UP)
    expect(sync.behind()).toEqual(["/api/shapes/items", "/api/shapes/pulls"])
    sync.answered(`${ORIGIN}/api/shapes/items?offset=-1`, 304, UP)
    expect(sync.behind()).toEqual(["/api/shapes/items", "/api/shapes/pulls"])
    sync.answered(`${ORIGIN}/api/shapes/items?offset=-1`, 200, UP)
    sync.answered(`${ORIGIN}/api/shapes/pulls?offset=-1&handle=h2`, 200, UP)
    expect(sync.behind()).toEqual([])
    expect(sync.count).toBe(3)
  })
})
