/** @jsxImportSource react */
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "bun:test"
import { PageFocus } from "../src/index"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

test("page changes focus the new heading or main; initial load and filters preserve focus", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = async (path: string, heading: boolean, main = true) => act(async () => {
    root.render(createElement("div", null,
      createElement("a", { href: "/", id: "nav" }, "Navigation"),
      main ? createElement("main", { key: path }, heading ? createElement("h1", null, path) : null, createElement("button", null, "Filter")) : null,
      createElement(PageFocus, { pathname: path })))
  })
  try {
    await render("/first", true)
    expect(document.activeElement).toBe(document.body)
    expect(host.querySelector("main")?.id).toBe("main-content")
    await render("/second", true)
    expect(document.activeElement).toBe(host.querySelector("h1"))
    const button = host.querySelector("button")!
    button.focus()
    await render("/second", true)
    expect(document.activeElement).toBe(button)
    await render("/third", false)
    expect(document.activeElement).toBe(host.querySelector("main"))
    await act(async () => {
      root.render(createElement("main", null, createElement("h1", null, "New issue"),
        createElement("form", { "data-page-focus": "" }, createElement("input")),
        createElement(PageFocus, { pathname: "/new" })))
    })
    expect(document.activeElement).toBe(host.querySelector("input"))
    expect(host.querySelector("input")!.tabIndex).toBe(0)
    await render("/empty", false, false)
    expect(document.activeElement).toBe(document.body)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
