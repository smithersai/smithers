// The first run's rules (src/features/first-run/view.ts, decision 0121): what `/app` shows in the composer's place for
// every state a person can be in, pure.
import { describe, expect, test } from "vitest"
import { type ComposerAccess, composerAccess } from "../auth/contract"
import type { Mine } from "../conversations/schema"
import {
  conversationsOf,
  type Conversations,
  firstRunOf,
  HIDDEN,
  offersSignIn,
  repositoryNamed,
  rowOf,
  sameFirstRun,
  showsGate,
  WAITING,
} from "./view"

const row = (archivedAt: string | null = null): Mine => ({
  conversationId: crypto.randomUUID(),
  personId: "person",
  owner: "octo",
  repo: "hello",
  branch: "main",
  openedAt: "2026-10-27T00:00:00Z",
  archivedAt,
  changedAt: "2026-10-27T00:00:00Z",
})

const run = (access: ComposerAccess, conversations: Conversations = "none", composerOpen = false) =>
  firstRunOf({ access, conversations, composerOpen })

const steps = (access: ComposerAccess, conversations: Conversations = "none") =>
  run(access, conversations).steps.map((step) => `${step.id}:${step.state}`)

describe("the steps", () => {
  test("a visitor signs in before asking", () => {
    for (const conversations of ["none", "loading"] as const) {
      expect(run("sign_in", conversations)).toMatchObject({ show: "steps", at: "sign_in" })
      expect(steps("sign_in", conversations)).toEqual(["sign_in:next", "ask:later"])
    }
  })

  test("a Member who may ask sees Ask Smithers", () => {
    expect(run("ask")).toMatchObject({ show: "steps", at: "ask" })
    expect(steps("ask")).toEqual(["sign_in:done", "ask:next"])
  })

  test("a person who cannot ask in the home conversation is shown how to open a repository", () => {
    for (const conversations of ["some", "loading", "none"] as const) {
      expect(run("members_only", conversations, true)).toEqual({
        show: "steps",
        at: "repository",
        steps: [{ id: "sign_in", state: "done" }, { id: "repository", state: "next" }],
      })
    }
  })
})

describe("the repository step's field", () => {
  test("names a repository as owner/name or its GitHub URL, trimmed", () => {
    expect(repositoryNamed("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" })
    expect(repositoryNamed("  acme/widgets.js  ")).toEqual({ owner: "acme", repo: "widgets.js" })
    expect(repositoryNamed("https://github.com/acme/widgets")).toEqual({ owner: "acme", repo: "widgets" })
    expect(repositoryNamed("http://www.github.com/acme/widgets.git/")).toEqual({ owner: "acme", repo: "widgets" })
  })

  test("anything else names none", () => {
    for (const text of ["", "acme", "acme/", "/widgets", "acme/widgets/tree/main", "https://gitlab.com/acme/widgets", "a b/c", "app/settings"]) {
      expect(repositoryNamed(text), text).toBeUndefined()
    }
  })
})

describe("when the steps don't show", () => {
  test("a person who may ask in /app's conversation and has had a conversation gets the gate, whatever else", () => {
    for (const access of ["ask", "sign_in"] as const) {
      expect(run(access, "some"), access).toEqual(HIDDEN)
    }
  })

  test("opening the composer to ask puts the composer in their place; before Ask it changes nothing", () => {
    expect(run("ask", "none", true)).toEqual(HIDDEN)
    expect(run("sign_in")).toMatchObject({ at: "sign_in" })
  })

  test("nothing shows while who the person is isn't known", () => {
    for (const conversations of ["none", "some", "loading"] as const) expect(run("wait", conversations)).toEqual(WAITING)
  })

  test("while their conversations aren't known, a person who may ask keeps the composer, and others see nothing yet", () => {
    expect(run("ask", "loading")).toEqual(HIDDEN)
    expect(run("sign_in", "loading")).toMatchObject({ at: "sign_in" })
  })
})

describe("what the device knows", () => {
  test("any row is a conversation, archived too; none once loaded; else not known", () => {
    expect(conversationsOf([row()], false)).toBe("some")
    expect(conversationsOf([row("2026-10-27T01:00:00Z")], true)).toBe("some")
    expect(conversationsOf([], true)).toBe("none")
    expect(conversationsOf([], false)).toBe("loading")
  })

  test("a signed-in Member without a hosted model can ask", () => {
    const member = { status: "signed_in" as const, role: "member" as const, restored: true, hostedModel: false }
    expect(run(composerAccess(member, undefined))).toMatchObject({ at: "ask" })
    expect(run(composerAccess({ ...member, role: "guest" }, undefined))).toMatchObject({ at: "repository" })
  })
})

describe("the composer's place and the header", () => {
  test("the gate shows when it isn't a first run, and at Ask; never while waiting or before Ask", () => {
    expect(showsGate(undefined)).toBe(false)
    expect(showsGate(WAITING)).toBe(false)
    expect(showsGate(HIDDEN)).toBe(true)
    expect(showsGate(run("ask"))).toBe(true)
    expect(showsGate(run("sign_in"))).toBe(false)
    expect(showsGate(run("members_only"))).toBe(false)
  })

  test("the header offers sign-in unless the Sign in step does", () => {
    expect(offersSignIn(run("sign_in"))).toBe(true)
    for (const firstRun of [undefined, WAITING, HIDDEN, run("ask"), run("members_only")]) {
      expect(offersSignIn(firstRun)).toBe(false)
    }
  })
})

describe("the row", () => {
  test("is keyed once, and the follower writes it only when what it shows changes", () => {
    expect(rowOf(WAITING)).toEqual({ id: "first-run", show: "wait", at: null, steps: [] })
    expect(sameFirstRun(run("ask"), run("ask"))).toBe(true)
    expect(sameFirstRun(run("ask"), run("sign_in"))).toBe(false)
    expect(sameFirstRun(WAITING, HIDDEN)).toBe(false)
    // The same step with a step whose state differs: Sign in to come for a visitor, done once at Ask.
    const visitor = run("sign_in")
    expect(sameFirstRun(visitor, { ...visitor, steps: [{ id: "sign_in", state: "done" }, { id: "ask", state: "later" }] })).toBe(false)
    expect(sameFirstRun(visitor, { ...visitor, steps: [{ id: "ask", state: "next" }, { id: "ask", state: "later" }] })).toBe(false)
  })
})

test("a conversation with history never shows first-run steps, signed in or signed out", () => {
  for (const access of ["sign_in", "members_only"] as const) {
    expect(firstRunOf({ access, conversations: "none", composerOpen: false, hasHistory: true })).toEqual(HIDDEN)
  }
})
