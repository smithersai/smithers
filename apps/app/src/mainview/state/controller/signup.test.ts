import { describe, expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { SIGNUP_QUESTIONS } from "../Signup"
import { backend, memoryStorage, silentAgent } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createSignupController } from "./signup"

const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return { store, controller: createSignupController(createControllerContext(store, silentAgent, backend({}))) }
}

describe("the signup controller", () => {
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

  test("answers advance one question at a time, multi-select toggles, every question may be skipped, and the last answer readies the workspace", async () => {
    const { store, controller } = await boot()
    controller.signupChange({ stage: "poll", question: 0 })
    expect(SIGNUP_QUESTIONS.filter(question => question.required)).toEqual([])
    expect(controller.signupNext()).toBeUndefined()
    expect(store.session().signup?.question).toBe(1)
    controller.signupBack()
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
