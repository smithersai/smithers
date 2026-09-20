import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Signup } from "../state/Signup"
import { initialSignup } from "../state/Signup"
import { SignupCardBody } from "./SignupCards"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []
afterEach(() => { for (const unmount of mounted.splice(0)) unmount() })

const render = (signup: Signup, repos: ReadonlyArray<{ id: string }> = [], doors = true) => {
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => { root.render(<SignupCardBody signup={signup} repos={repos} doors={doors} onRunCommand={(name, args) => { calls.push([name, args]) }} />) })
  mounted.push(() => { flushSync(() => root.unmount()); host.remove() })
  const flows = () => [...host.querySelectorAll<HTMLElement>("button[data-flow]")].map(b => [b.textContent?.trim(), b.dataset.flow, b.dataset.flowArgs])
  return { host, calls, flows }
}

describe("the signup cards", () => {
  test("the first card carries the title and offers GitHub through auth.sign-in, Google through signup.google, and the email form through signup.email", () => {
    const { host, flows, calls } = render({ ...initialSignup(), draft: { email: "ada@acme.dev" } })
    expect(host.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Automate your codebase today")
    expect(flows().map(row => row[1])).toEqual(["auth.sign-in", "signup.google"])
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(calls).toEqual([["signup.email", "ada@acme.dev"]])
  })

  test("before identity answers, a first visit paints the title alone: no door, no receipt", () => {
    const { host, flows } = render(initialSignup(), [], false)
    expect(host.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Automate your codebase today")
    expect(flows()).toEqual([])
    expect(host.querySelector("form")).toBeNull()
  })

  test("the account step prefills the GitHub login under smithers.sh/ and submits through signup.account", () => {
    const { host, calls } = render({ ...initialSignup(), stage: "account", door: "github", account: "adapark", draft: { account: "adapark", name: "Ada Park" } })
    expect(host.querySelector<HTMLInputElement>('[data-testid="signup-account"]')?.value).toBe("adapark")
    expect(host.querySelector(".signup-prefix")?.textContent).toBe("smithers.sh/")
    expect(host.querySelector(".signup-url")?.getAttribute("data-valid")).toBe("true")
    expect([...host.querySelectorAll(".signup-receipt")].map(r => r.textContent)).toEqual(["Signed in with GitHub"])
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(calls).toEqual([["signup.account", undefined]])
  })

  test("a poll question renders its lettered choices as signup.answer buttons, a letter key answers, and a required question has no Skip", () => {
    const { host, flows, calls } = render({ ...initialSignup(), stage: "poll", question: 1 })
    expect(host.querySelector("h2")?.textContent).toBe("What best describes your role?*")
    expect(flows().filter(row => row[1] === "signup.answer").map(row => row[2])).toEqual(["Executive/Owner", "Engineering", "Support", "Marketing", "Product & Design", "Sales", "IT", "Other"])
    expect(host.querySelector('[data-testid="signup-skip"]')).toBeNull()
    expect(flows().some(row => row[1] === "signup.back")).toBe(true)
    host.querySelector<HTMLElement>(".signup-choice")!.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }))
    expect(calls).toEqual([["signup.answer", "Engineering"]])
  })

  test("the repo question lists the GitHub repositories for a GitHub sign-in and offers Connect GitHub otherwise", () => {
    const github = render({ ...initialSignup(), stage: "poll", question: 5, door: "github" }, [{ id: "adapark/hello-server" }])
    expect(github.flows().filter(row => row[1] === "signup.repo").map(row => row[2])).toEqual(["adapark/hello-server", "new"])
    const email = render({ ...initialSignup(), stage: "poll", question: 5, door: "email" })
    expect(email.flows().map(row => row[1])).toEqual(["auth.sign-in", "signup.repo", "signup.back", "signup.next"])
  })

  test("ready shows the account URL, the giant Start Automating door, and the tutorial slot", () => {
    const { host, flows } = render({ ...initialSignup(), stage: "ready", account: "adapark" })
    expect(host.querySelector(".signup-url-line")?.textContent).toBe("smithers.sh/adapark")
    expect(flows()).toEqual([["Start Automating", "signup.finish", undefined]])
    expect(host.querySelector('[data-testid="signup-video"]')).not.toBeNull()
  })
})
