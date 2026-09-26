import { describe, expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { accountSlug, initialSignup, SIGNUP_QUESTIONS, signupActive, signupAfterIdentity, signupOpening, validAccountName } from "./Signup"
import { memoryStorage } from "./TestFixtures"

describe("Signup", () => {
  test("an account name is a smithers.sh path segment", () => {
    expect(accountSlug("Ada Park!")).toBe("adapark")
    expect(validAccountName("adapark")).toBe(true)
    expect(validAccountName("a")).toBe(false)
    expect(validAccountName("-ada")).toBe(false)
    expect(validAccountName("a".repeat(40))).toBe(false)
  })

  test("the onboarding owns the transcript for a signed-out visitor and for any unfinished stage, never for a legacy signed-in session", () => {
    expect(signupActive(undefined, "signed-out")).toBe(true)
    expect(signupActive(undefined, "signed-in")).toBe(false)
    expect(signupActive(undefined, "unknown")).toBe(false)
    expect(signupActive({ ...initialSignup(), stage: "poll" }, "signed-in")).toBe(true)
    expect(signupActive({ ...initialSignup(), stage: "done" }, "signed-in")).toBe(false)
  })

  test("before identity answers, a browser with no retained owner opens on the title alone, and a retained owner sees no signup", () => {
    expect(signupOpening(undefined, "unknown", null)).toBe("title")
    expect(signupOpening(undefined, undefined, undefined)).toBe("title")
    expect(signupOpening(undefined, "unknown", "will")).toBe(false)
    expect(signupOpening(undefined, "signed-out", null)).toBe("full")
    expect(signupOpening(undefined, "signed-in", null)).toBe(false)
    expect(signupOpening({ ...initialSignup(), stage: "poll" }, "unknown", "will")).toBe("full")
  })

  test("a GitHub sign-in carries the doors to the account step with the login prefilled, and leaves a later stage alone", () => {
    const moved = signupAfterIdentity(initialSignup(), "signed-in", "Ada-Park", null)
    expect(moved?.stage).toBe("account")
    expect(moved?.account).toBe("ada-park")
    expect(moved?.draft.account).toBe("ada-park")
    const poll = { ...initialSignup(), stage: "poll" as const, question: 3 }
    expect(signupAfterIdentity(poll, "signed-in", "ada", null)).toBe(poll)
    // No row yet: a browser that never held an owner starts at the account step; one that did is a returning person.
    expect(signupAfterIdentity(undefined, "signed-in", "ada", null)?.stage).toBe("account")
    expect(signupAfterIdentity(undefined, "signed-in", "ada", "ada")).toBeUndefined()
  })

  test("the poll asks the seven questions Will listed, in order, none required", () => {
    expect(SIGNUP_QUESTIONS.map(q => q.id)).toEqual(["size", "role", "heard", "know", "models", "repo", "more"])
    expect(SIGNUP_QUESTIONS.filter(q => q.required).map(q => q.id)).toEqual([])
  })

  test("signup.changed merges onto the row and a sign-in advances an unfinished signup through the projection", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    try {
      expect(store.session().signup).toBeUndefined()
      store.dispatch({ type: "signup.changed", actor: "user", patch: { draft: {} } })
      expect(store.session().signup).toEqual(initialSignup())
      store.dispatch({ type: "signup.changed", actor: "user", patch: { draft: { email: "ada@acme.dev" } } })
      expect(store.session().signup?.stage).toBe("sign-in")
      expect(store.session().signup?.draft).toEqual({ email: "ada@acme.dev" })
      store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "adapark", allowlisted: true, admin: false, scopesPlain: null })
      expect(store.session().signup?.stage).toBe("account")
      expect(store.session().signup?.account).toBe("adapark")
    } finally { await store.dispose?.() }
  })
})
