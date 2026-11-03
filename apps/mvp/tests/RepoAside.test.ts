// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"
import { RepoAside } from "../src/features/repo/components/RepoAside"
import { pageOf } from "../src/features/repo/view"
import { emptyView } from "../src/features/repo/rows"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

test("a cloned repository keeps its files and offers a clickable retry for failed About in the aside", async () => {
  const about = { key: "github/octocat/spoon-knife", state: "failed" as const, about: null, message: "GitHub limit reached." }
  // A resolved clone shows files even before its synced repository row arrives.
  expect(pageOf({ view: { ...emptyView, missing: false, owner: "octocat", name: "Spoon-Knife", sha: "a".repeat(40) }, about }).kind).toBe("files")
  let retries = 0
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(RepoAside, { about, repository: undefined, onRetry: () => { retries++ } })))
    expect(container.textContent).toContain(about.message)
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")
    expect(retry).toBeDefined()
    await act(async () => retry!.click())
    expect(retries).toBe(1)
    await act(async () => root.render(createElement(RepoAside, { about: { ...about, state: "loading", message: null }, repository: undefined, onRetry: () => { retries++ } })))
    expect(container.querySelector("button")).toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
