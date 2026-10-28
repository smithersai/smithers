// What a branch's page lets this person do right now (src/features/branch/view.ts, docs/features/branch-workspace.md#sharing).
import { describe, expect, test } from "vitest"
import { MEMBERS_ASK } from "../auth/contract"
import { accessNow, deniedTitleOf, NO_ACCESS, statusOf, writes } from "./view"

describe("accessNow", () => {
  test("nothing until the branch is ready; what tracking answered until the room says otherwise", () => {
    expect(accessNow(undefined, undefined, undefined)).toBeUndefined()
    expect(accessNow({ status: "tracking", access: null }, undefined, undefined)).toBeUndefined()
    expect(accessNow({ status: "ready", access: null }, undefined, undefined)).toBeUndefined()
    expect(accessNow({ status: "ready", access: "view" }, { status: "connecting" }, undefined)).toBe("view")
  })

  test("the room's roster says the access now: write is edit, read is view; the owner stays the owner", () => {
    expect(accessNow({ status: "ready", access: "view" }, { status: "open" }, "write")).toBe("edit")
    expect(accessNow({ status: "ready", access: "edit" }, { status: "open" }, "read")).toBe("view")
    expect(accessNow({ status: "ready", access: "owner" }, { status: "open" }, "write")).toBe("owner")
  })

  test("a room closed for no access is no access, the owner's too", () => {
    expect(accessNow({ status: "ready", access: "edit" }, { status: "revoked" }, "write")).toBe("none")
    expect(accessNow({ status: "ready", access: "owner" }, { status: "revoked" }, undefined)).toBe("none")
  })
})

describe("writes", () => {
  test("the owner and an editor write; a viewer, no access and not yet don't", () => {
    expect([writes("owner"), writes("edit"), writes("view"), writes("none"), writes(undefined)]).toEqual([
      true,
      true,
      false,
      false,
      false,
    ])
  })
})

describe("statusOf", () => {
  // Will couldn't tell what the branch page was from its recordings (2026-10-20): the chrome now says what this person
  // may do on the branch, in the share dialog's words.
  test("the person's access in the share dialog's words; nothing before it is known or after it was taken away", () => {
    expect([statusOf("owner"), statusOf("edit"), statusOf("view")]).toEqual(["Owner", "Can edit", "Can view"])
    expect(statusOf("none")).toBeUndefined()
    expect(statusOf(undefined)).toBeUndefined()
  })
})

describe("deniedTitleOf", () => {
  test("someone signed in below Member on the repository reads Members can ask Smithers.; anyone else No access (ruling AUTH-8)", () => {
    expect(deniedTitleOf(true, { role: "guest" })).toBe(MEMBERS_ASK)
    expect(deniedTitleOf(true, { role: null })).toBe(MEMBERS_ASK)
    // A Member there denied a branch is denied the branch: someone else's, not shared with them.
    expect(deniedTitleOf(true, { role: "member" })).toBe(NO_ACCESS)
    expect(deniedTitleOf(true, undefined)).toBe(NO_ACCESS)
    expect(deniedTitleOf(false, { role: null })).toBe(NO_ACCESS)
  })
})
