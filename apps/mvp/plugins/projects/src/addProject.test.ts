// @vitest-environment happy-dom
import type { Host } from "@smthrs/plugin"
import { Deferred, Effect, Exit, Scope } from "effect"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"
import { ProjectFormProvider, ProjectsHome } from "../../../src/features/projects/components/ProjectsHome"
import { makeProjectForm } from "../../../src/features/projects/draft.vibe"
import type { ProjectsLive, ProjectsSnapshot } from "../../../src/features/projects/schema"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

test("the repository field retains a failed save, blocks repeated presses, and refreshes on a successful retry", async () => {
  const scope = Effect.runSync(Scope.make())
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const requests: unknown[] = []
  const refreshes: string[] = []
  let receipt = Effect.runSync(Deferred.make<Host.Settled>())
  const personId = "test-owner"
  const snapshot: ProjectsSnapshot = { id: "projects", personId, status: "ready", projects: [], summaries: [], summariesPending: false }
  const snapshots = [snapshot]
  const empty: ReadonlyArray<ProjectsSnapshot> = []
  let visible = true
  const projects: ProjectsLive = {
    current: () => visible ? snapshots : empty,
    subscribe: () => () => {},
    refresh: (person) => { if (visible) refreshes.push(person) },
  }
  let signedInOwner: string | undefined = personId
  let ownerChanged: (() => void) | undefined
  const owner = {
    current: () => signedInOwner,
    subscribe: (listener: () => void) => { ownerChanged = listener; return () => { ownerChanged = undefined } },
  }
  const ui = await Effect.runPromise(makeProjectForm(projects, owner, (fields) =>
    Effect.suspend(() => {
      requests.push(fields)
      return Deferred.await(receipt)
    }),
  ).pipe(Scope.provide(scope)))
  const render = () => act(async () => root.render(createElement(ProjectFormProvider, { value: ui }, createElement(ProjectsHome, { children: null }))))
  try {
    await render()
    const input = container.querySelector("input")!
    const form = container.querySelector("form")!
    const button = container.querySelector("button")!
    const status = container.querySelector('[role="status"]')!
    const enter = (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    // The browser test drives trusted presses. Here the host action runs directly to exercise its settlement states.
    const press = () => act(async () => ui.submit(personId))
    const settle = (value: Host.Settled) => act(async () => { await Effect.runPromise(Deferred.succeed(receipt, value)) })

    expect(container.querySelector("label")?.textContent).toBe("Repository")
    expect(container.querySelector("label")?.htmlFor).toBe(input.id)
    expect(button.textContent).toBe("Add project")
    await enter("malformed")
    await press()
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(requests).toHaveLength(0)

    await enter("  Example/Idle-Project ")
    await act(async () => { button.click(); form.requestSubmit() })
    expect(requests).toHaveLength(0)
    await press()
    expect(status.textContent).toBe("Adding project…")
    expect(button.disabled).toBe(true)
    await press()
    expect(requests).toEqual([{ project: "example/idle-project", personId }])
    expect(refreshes).toEqual([])
    await settle({ _tag: "Failed", code: "unavailable" })
    expect(status.textContent).toBe("Couldn’t add project. Try again.")
    expect(input.value).toBe("  Example/Idle-Project ")
    expect(button.disabled).toBe(false)

    receipt = Effect.runSync(Deferred.make<Host.Settled>())
    await press()
    await settle({ _tag: "Done" })
    expect(refreshes).toEqual([personId])
    expect(input.value).toBe("")
    expect(status.textContent).toBe("Project added.")

    receipt = Effect.runSync(Deferred.make<Host.Settled>())
    await enter("example/keep-private")
    await press()
    visible = false
    await act(async () => root.render(null))
    await settle({ _tag: "Failed", code: "unavailable" })
    visible = true
    await render()
    expect(container.querySelector("input")?.value).toBe("example/keep-private")
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Couldn’t add project. Try again.")
    await act(async () => { signedInOwner = undefined; ownerChanged?.() })
    expect(refreshes).toEqual([personId])
    expect(container.querySelector("input")?.value).toBe("")
    expect(container.querySelector('[role="status"]')?.textContent).toBe("")
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})
