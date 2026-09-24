import { describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { SIGNUP_QUESTIONS } from "../Signup"
import { backend, json, memoryStorage, silentAgent } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createSignupController, SIGNUP_DOOR_UNAVAILABLE, SIGNUP_EMAIL_START_PATH } from "./signup"

const boot = async (routes: Record<string, Response> = {}) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const toasts: Array<string> = []
  const ctx = createControllerContext(store, silentAgent, backend(routes))
  ctx.withToast = async (key, _title, _done, work) => { toasts.push(key); return work() }
  return { store, toasts, controller: createSignupController(ctx) }
}

describe("the signup controller", () => {
  test("a host without the email door answers a typed refusal and the doors stay open", async () => {
    const { store, controller, toasts } = await boot()
    expect(await controller.signupEmail("not an email")).toBe("Type a company email like you@company.com.")
    const refusal = await controller.signupEmail("ada@acme.dev")
    expect(refusal).toBe(`Email sign-in: ${SIGNUP_DOOR_UNAVAILABLE}`)
    expect(toasts).toEqual(["signup.email"])
    expect(store.session().signup?.stage ?? "sign-in").toBe("sign-in")
    await store.dispose?.()
  })

  test("a host with the email door moves to the code step, and a wrong-length code is refused before any request", async () => {
    const { store, controller } = await boot({ [SIGNUP_EMAIL_START_PATH]: json(200, { ok: true }) })
    expect(await controller.signupEmail("ada@acme.dev")).toBeUndefined()
    expect(store.session().signup).toMatchObject({ stage: "verify", door: "email", email: "ada@acme.dev" })
    expect(await controller.signupVerify("12")).toBe("Type the 6-digit code from the email.")
    await store.dispose?.()
  })

  test("the account step needs a name and a valid account, then opens the poll", async () => {
    const { store, controller } = await boot()
    controller.signupChange({ stage: "account" })
    expect(controller.signupAccount()).toBe("Type your full name.")
    controller.signupSet("name", "Ada Park")
    controller.signupSet("account", "a")
    expect(controller.signupAccount()).toBe("An account name is 2–39 lowercase letters, digits or hyphens.")
    controller.signupSet("account", "Ada Park")
    expect(controller.signupAccount()).toBeUndefined()
    expect(store.session().signup).toMatchObject({ stage: "poll", name: "Ada Park", account: "adapark", question: 0 })
    await store.dispose?.()
  })

  test("answers advance one question at a time, multi-select toggles, required questions refuse a skip, and the last answer readies the workspace", async () => {
    const { store, controller } = await boot()
    controller.signupChange({ stage: "poll", question: 0 })
    expect(controller.signupNext()).toBe("This one needs an answer.")
    expect(controller.signupAnswer("Huge")).toContain("Choose one of")
    controller.signupAnswer("2–10")
    expect(store.session().signup?.question).toBe(1)
    controller.signupBack()
    expect(store.session().signup?.question).toBe(0)
    controller.signupAnswer("2–10")
    controller.signupAnswer("Engineering")
    controller.signupNext() // heard: optional
    controller.signupAnswer("Yes")
    expect(SIGNUP_QUESTIONS[store.session().signup!.question]?.id).toBe("models")
    controller.signupAnswer("Claude")
    controller.signupAnswer("Codex")
    controller.signupAnswer("Claude")
    expect(store.session().signup?.answers.models).toEqual(["Codex"])
    controller.signupNext()
    controller.signupRepo("new")
    controller.signupSet("more", "  ship it ")
    controller.signupNext()
    expect(store.session().signup).toMatchObject({ stage: "ready", repo: "new", answers: { size: "2–10", role: "Engineering", know: "Yes", models: ["Codex"], repo: "new", more: "ship it" } })
    controller.signupFinish()
    expect(store.session().signup?.stage).toBe("done")
    await store.dispose?.()
  })
})
