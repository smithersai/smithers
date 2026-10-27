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
  const render = async (path: string, heading: boolean, main = true, preferred = false) => act(async () => {
    root.render(createElement("div", null,
      createElement("a", { href: "/", id: "nav" }, "Navigation"),
      main ? createElement("main", { key: path }, heading ? createElement("h1", null, path) : null, createElement("button", null, "Filter"), preferred ? createElement("form", { "data-page-focus": "" }, createElement("input")) : null) : null,
      createElement(PageFocus, { pathname: path })))
  })
  try {
    await render("/first", true)
    expect(document.activeElement === document.body).toBe(true)
    expect(host.querySelector("main")?.id).toBe("main-content")
    await render("/second", true)
    expect(document.activeElement === host.querySelector("h1")).toBe(true)
    const button = host.querySelector("button")!
    button.focus()
    await render("/second", true)
    expect(document.activeElement === button).toBe(true)
    await render("/third", false)
    expect(document.activeElement === host.querySelector("main")).toBe(true)
    await render("/new", true, true, true)
    expect(document.activeElement === host.querySelector("input")).toBe(true)
    expect(host.querySelector("input")!.tabIndex).toBe(0)
    await render("/empty", false, false)
    expect(document.activeElement === document.body).toBe(true)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})


test("a report form keeps its preferred textarea focused after client navigation", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement("div", null, createElement("main", null, "Chat"), createElement(PageFocus, { pathname: "/app" }))))
    await act(async () => root.render(createElement("div", null,
      createElement("main", null,
        createElement("h1", null, "Report a bug"),
        createElement("form", { "data-page-focus": "" }, createElement("textarea", { "aria-label": "What happened?", autoFocus: true }))),
      createElement(PageFocus, { pathname: "/app/bugs/report" }))))
    expect(document.activeElement).toBe(host.querySelector("textarea"))
    expect(host.querySelector("textarea")!.tabIndex).toBe(0)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
