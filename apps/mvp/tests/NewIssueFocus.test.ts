// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"
import { NewIssueForm } from "../src/features/issues/components/NewIssueForm"
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

test("opening an issue focuses Title; editing the draft preserves Description focus", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = async (body: string) => act(async () => {
    root.render(createElement(NewIssueForm, { title: "", body, onTitle: () => {}, onBody: () => {}, onSubmit: () => {} }))
  })
  try {
    await render("")
    expect(document.activeElement).toBe(host.querySelector("input"))
    const description = host.querySelector("textarea")!
    description.focus()
    await render("Draft")
    expect(document.activeElement).toBe(description)
  } finally { await act(async () => root.unmount()); host.remove() }
})
