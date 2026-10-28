// The first run's rules (src/features/first-run/view.ts, decision 0121): what `/app` shows in the composer's place for
// every state a person can be in, pure.
import { describe, expect, test } from "vitest"
import { type ComposerAccess, composerAccess, type OwnModel } from "../auth/contract"
import type { Mine } from "../conversations/schema"
import {
  conversationsOf,
  type Conversations,
  firstRunOf,
  HIDDEN,
  offersSignIn,
  ownOf,
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

const run = (
  access: ComposerAccess,
  conversations: Conversations = "none",
  hostedModel: boolean | undefined = false,
  composerOpen = false,
  own: OwnModel = "none",
) => firstRunOf({ access, hostedModel, own, conversations, composerOpen })

/** The steps as `id:state`, in order. */
const steps = (access: ComposerAccess, conversations: Conversations = "none", hostedModel: boolean | undefined = false) =>
  run(access, conversations, hostedModel).steps.map((step) => `${step.id}:${step.state}`)

describe("the steps", () => {
  test("a visitor is at Sign in, with Add your model and Ask Smithers to come, whatever the device knows of their conversations", () => {
    for (const conversations of ["none", "loading"] as const) {
      expect(run("sign_in", conversations)).toMatchObject({ show: "steps", at: "sign_in" })
      expect(steps("sign_in", conversations)).toEqual(["sign_in:next", "model:later", "ask:later"])
    }
  })

  test("Add your model shows only while the deployment's model is off, or not known yet", () => {
    expect(steps("sign_in", "none", true)).toEqual(["sign_in:next", "ask:later"])
    expect(steps("sign_in", "none", undefined)).toEqual(["sign_in:next", "model:later", "ask:later"])
    expect(steps("ask", "none", true)).toEqual(["sign_in:done", "ask:next"])
  })

  test("a Member without a model is at Add your model, Sign in done", () => {
    expect(run("add_model")).toMatchObject({ show: "steps", at: "model" })
    expect(steps("add_model")).toEqual(["sign_in:done", "model:next", "ask:later"])
  })

  test("a Member who may ask is at Ask Smithers, every step before it done", () => {
    expect(run("ask")).toMatchObject({ show: "steps", at: "ask" })
    expect(steps("ask")).toEqual(["sign_in:done", "model:done", "ask:next"])
  })

  test("a person who may not ask in /app's conversation is shown their own repository's, after their model (ruling AUTH-8)", () => {
    expect(run("members_only")).toEqual({
      show: "steps",
      at: "model",
      steps: [{ id: "sign_in", state: "done" }, { id: "model", state: "next" }, { id: "repository", state: "later" }],
    })
    // The deployment's model never answers them, so their own is a step whatever ChatApi says of it.
    expect(run("members_only", "none", true, false, "saved")).toEqual({
      show: "steps",
      at: "repository",
      steps: [{ id: "sign_in", state: "done" }, { id: "model", state: "done" }, { id: "repository", state: "next" }],
    })
    // Nothing until their model's rows are ready, as the gate waits.
    expect(run("members_only", "none", false, false, "loading")).toEqual(WAITING)
  })

  test("the repository step stays for them with conversations of their own, and with the composer open", () => {
    for (const conversations of ["some", "loading", "none"] as const) {
      expect(run("members_only", conversations, false, true, "saved"), conversations).toMatchObject({ show: "steps", at: "repository" })
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
    for (const access of ["ask", "add_model", "sign_in"] as const) {
      expect(run(access, "some"), access).toEqual(HIDDEN)
    }
  })

  test("opening the composer to ask puts the composer in their place; before Ask it changes nothing", () => {
    expect(run("ask", "none", false, true)).toEqual(HIDDEN)
    expect(run("add_model", "none", false, true)).toMatchObject({ at: "model" })
    expect(run("sign_in", "none", false, true)).toMatchObject({ at: "sign_in" })
  })

  test("nothing shows while who the person is isn't known", () => {
    for (const conversations of ["none", "some", "loading"] as const) expect(run("wait", conversations)).toEqual(WAITING)
  })

  test("while their conversations aren't known, a person who may ask keeps the composer, and others see nothing yet", () => {
    expect(run("ask", "loading")).toEqual(HIDDEN)
    expect(run("add_model", "loading")).toEqual(WAITING)
  })
})

describe("what the device knows", () => {
  test("any row is a conversation, archived too; none once loaded; else not known", () => {
    expect(conversationsOf([row()], false)).toBe("some")
    expect(conversationsOf([row("2026-10-27T01:00:00Z")], true)).toBe("some")
    expect(conversationsOf([], true)).toBe("none")
    expect(conversationsOf([], false)).toBe("loading")
  })

  test("a saved model, none once its rows are ready, else not known: as the gate reads it", () => {
    expect(ownOf(1, false)).toBe("saved")
    expect(ownOf(0, true)).toBe("none")
    expect(ownOf(0, false)).toBe("loading")
  })

  test("composed with the gate's access, a Member without a model whose rows haven't synced sees nothing yet", () => {
    const member = { status: "signed_in" as const, role: "member" as const, restored: true, hostedModel: false }
    expect(run(composerAccess(member, undefined, ownOf(0, false)))).toEqual(WAITING)
    expect(run(composerAccess(member, undefined, ownOf(0, true)))).toMatchObject({ at: "model" })
    expect(run(composerAccess(member, undefined, ownOf(1, true)))).toMatchObject({ at: "ask" })
    expect(run(composerAccess({ ...member, role: "guest" }, undefined, ownOf(0, true)))).toMatchObject({ at: "model" })
  })
})

describe("the composer's place and the header", () => {
  test("the gate shows when it isn't a first run, and at Ask; never while waiting or before Ask", () => {
    expect(showsGate(undefined)).toBe(false)
    expect(showsGate(WAITING)).toBe(false)
    expect(showsGate(HIDDEN)).toBe(true)
    expect(showsGate(run("ask"))).toBe(true)
    expect(showsGate(run("sign_in"))).toBe(false)
    expect(showsGate(run("add_model"))).toBe(false)
    expect(showsGate(run("members_only"))).toBe(false)
  })

  test("the header offers sign-in unless the Sign in step does", () => {
    expect(offersSignIn(run("sign_in"))).toBe(true)
    for (const firstRun of [undefined, WAITING, HIDDEN, run("ask"), run("add_model"), run("members_only")]) {
      expect(offersSignIn(firstRun)).toBe(false)
    }
  })
})

describe("the row", () => {
  test("is keyed once, and the follower writes it only when what it shows changes", () => {
    expect(rowOf(WAITING)).toEqual({ id: "first-run", show: "wait", at: null, steps: [] })
    expect(sameFirstRun(run("ask"), run("ask"))).toBe(true)
    expect(sameFirstRun(run("ask"), run("add_model"))).toBe(false)
    expect(sameFirstRun(run("ask"), run("ask", "none", true))).toBe(false)
    expect(sameFirstRun(WAITING, HIDDEN)).toBe(false)
    // The same step with a step whose state differs: Sign in to come for a visitor, done once at Ask.
    const visitor = run("sign_in", "none", true)
    expect(sameFirstRun(visitor, { ...visitor, steps: [{ id: "sign_in", state: "done" }, { id: "ask", state: "later" }] })).toBe(false)
    expect(sameFirstRun(visitor, { ...visitor, steps: [{ id: "ask", state: "next" }, { id: "ask", state: "later" }] })).toBe(false)
  })
})
