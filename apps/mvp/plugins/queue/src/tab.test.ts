// The queue's cursor (plugins/queue/src/tab.ts): where it rests as the person moves and as waits arrive and leave. The
// tab itself runs over real waits in src/plugins/plugins.test.ts; one conversation holds one open wait at a time, so
// several waiting at once (one per branch conversation) are proved here, on the cursor's own rules.
import { describe, expect, test } from "vitest"
import { clamp, follow, repositoryOf } from "./tab"

const rows = (...ids: Array<string>) => ids.map((runId) => ({ runId }))

describe("the queue's cursor", () => {
  test("j and k move inside the queue and stop at its ends", () => {
    expect(clamp(1, 3)).toBe(1)
    expect(clamp(3, 3)).toBe(2)
    expect(clamp(-1, 3)).toBe(0)
    expect(clamp(0, 0)).toBe(0)
    expect(clamp(5, 0)).toBe(0)
  })

  test("a wait arriving or leaving elsewhere keeps the cursor on its item", () => {
    expect(follow(rows("a", "b", "c"), "b", 1)).toBe(1)
    expect(follow(rows("x", "a", "b", "c"), "b", 1)).toBe(2)
    expect(follow(rows("b", "c"), "b", 1)).toBe(0)
  })

  test("when its item leaves, the cursor rests on the one that took its place", () => {
    expect(follow(rows("a", "c"), "b", 1)).toBe(1)
    expect(clamp(follow(rows("a"), "b", 1), 1)).toBe(0)
    expect(follow(rows(), undefined, 0)).toBe(0)
  })

  test("the item's repository reads as owner and name; a wait that names none has none", () => {
    expect(repositoryOf("github/acme/widgets")).toBe("acme/widgets")
    expect(repositoryOf("")).toBeUndefined()
  })
})
