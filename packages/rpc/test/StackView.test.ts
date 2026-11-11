import { describe, expect, test } from "vitest"
import { type MythicalChange, type MythicalItem, type MythicalStack } from "../src/Mythical.ts"
import { accountLabel, ACTIVE_ITEM_STATES, itemReason, itemStateLabel, itemTitle, settled } from "../src/StackView.ts"

const head = "c".repeat(40)
const proposed: MythicalItem = {
  id: "item-1",
  issue: { number: 12, title: "Add the footer link", url: "https://github.com/o/r/issues/12" },
  state: "proposed",
  attempt: 1,
  runs: {},
  todo: { replans: 0 },
  pullRequest: { number: 40, url: "https://github.com/o/r/pull/40", state: "open", head },
  dependsOn: [],
  updatedAt: "2026-09-30T10:00:00Z"
}

const item = (id: string, state: MythicalItem["state"], extra: Partial<MythicalItem> = {}): MythicalItem => ({
  id,
  state,
  attempt: 1,
  runs: {},
  dependsOn: [],
  updatedAt: "2026-09-30T10:00:00Z",
  ...extra
})

const change = (changeId: string, extra: Partial<MythicalChange> = {}): MythicalChange => ({
  changeId,
  commitId: `${changeId}-commit`,
  title: `Change ${changeId}`,
  kind: "item",
  state: "pending",
  ...extra
})

const stackOf = (extra: Partial<MythicalStack>): MythicalStack => ({
  repository: "o/r",
  state: "active",
  generation: 1,
  mainBehind: false,
  changes: [],
  items: [],
  lanes: [],
  limits: { maxParallel: 2 },
  ...extra
})

describe("item labels", () => {
  test("each API state reads in the owner's words", () => {
    expect(
      (["running", "delivering", "integrating", "verifying", "waiting", "proposed", "queued", "blocked"] as const).map(
        (state) => itemStateLabel(item("x", state))
      )
    ).toEqual(["implementing", "checking", "rebasing", "checking", "ready", "PR open", "queued", "blocked"])
  })

  test("an issue item is titled by its issue, a chat item by its change, else by a short id", () => {
    const stack = stackOf({ changes: [change("c", { itemId: "chat-item-1", title: "Rename the footer" })] })
    expect(itemTitle(stack, proposed)).toBe("#12 Add the footer link")
    expect(itemTitle(stack, item("chat-item-1", "waiting"))).toBe("Rename the footer")
    expect(itemTitle(stack, item("0123456789abcdef", "queued"))).toBe("01234567")
  })

  test("a retrying item names its conflicted paths until a typed failure explains it", () => {
    const integration = { conflict: { paths: ["a.ts", "b.ts"] } }
    expect(itemReason(item("x", "retrying", { integration, reason: "conflict" }))).toBe("a.ts, b.ts")
    expect(
      itemReason(
        item("x", "retrying", { integration, reason: "Checks failed", failure: { kind: "checks", fault: "user" } })
      )
    ).toBe("Checks failed")
    expect(itemReason(item("x", "blocked", { integration, reason: "Needs a person" }))).toBe("Needs a person")
    expect(itemReason(item("x", "blocked", { reason: "" }))).toBeUndefined()
    expect(itemReason(item("x", "queued"))).toBeUndefined()
  })

  test("an account reads its label or provider, and how many more served the lane", () => {
    expect(accountLabel({ provider: "claude", count: 1 })).toBe("Claude")
    expect(accountLabel({ provider: "codex", label: "work@example.com", count: 3 })).toBe("work@example.com +2")
  })

  test("settled covers finished, stopped and proposed items, not working ones", () => {
    expect(
      ["landed", "blocked", "declined", "proposed"].every((state) => settled(item("x", state as MythicalItem["state"])))
    ).toBe(true)
    expect([...ACTIVE_ITEM_STATES, "queued"].some((state) => settled(item("x", state as MythicalItem["state"])))).toBe(
      false
    )
  })
})
