// @vitest-environment happy-dom
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const list = vi.hoisted(() => ({ next: (): Promise<Array<unknown>> => Promise.resolve([]) }))
vi.mock("../src/shell/client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shell/client.ts")>()
  return { ...actual, listSessions: () => list.next() }
})
vi.mock("@smthrs/ui", async () => {
  const { createElement } = await import("react")
  const container = ({ children }: { readonly children?: ReactNode }) => createElement("div", null, children)
  const hidden = () => null
  return {
    Card: container, CardContent: container, CardDescription: container, CardHeader: container, CardTitle: container,
    ChatTranscript: container, ChatMessage: container, CollapsiblePanel: container,
    Badge: container, Select: container, Button: container,
    ChatComposer: hidden, FileTree: hidden, StatusPill: hidden,
    EmptyState: ({ title }: { readonly title: string }) => createElement("p", null, title),
    SelectContent: hidden, SelectItem: hidden, SelectTrigger: hidden, SelectValue: hidden,
    Dialog: hidden, DialogContent: hidden, DialogDescription: hidden, DialogHeader: hidden, DialogTitle: hidden,
    formatRelativeTime: () => "now"
  }
})

let container: HTMLDivElement
let root: import("react-dom/client").Root
let act: typeof import("react").act
let createElement: typeof import("react").createElement
let BuildPage: typeof import("../app/build/page.tsx").default
let actions: typeof import("../src/shell/store.ts").actions

// The store is module state; a fresh module graph per test keeps each test
// independent of the order the others ran in.
beforeEach(async () => {
  vi.resetModules()
  ;({ act, createElement } = await import("react"))
  const { createRoot } = await import("react-dom/client")
  BuildPage = (await import("../app/build/page.tsx")).default
  ;({ actions } = await import("../src/shell/store.ts"))
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const recent = (): string => container.querySelector("[aria-label='Recent']")?.textContent ?? ""

describe("Recent column empty state", () => {
  test("before any read it claims neither an empty list nor a failure", async () => {
    await act(() => root.render(createElement(BuildPage)))
    expect(recent()).not.toContain("No runs yet")
    expect(recent()).not.toContain("Couldn't load runs.")
    expect(recent()).not.toContain("Sample data")
  })

  test("a failed read says so, not that the list is empty", async () => {
    list.next = () => Promise.reject(new Error("offline"))
    await act(() => actions.refreshSessions())
    await act(() => root.render(createElement(BuildPage)))
    expect(recent()).toContain("Couldn't load runs.")
    expect(recent()).not.toContain("No runs yet")
  })

  test("an empty read says the list is empty", async () => {
    list.next = () => Promise.resolve([])
    await act(() => actions.refreshSessions())
    await act(() => root.render(createElement(BuildPage)))
    expect(recent()).toContain("No runs yet")
    expect(recent()).not.toContain("Couldn't load runs.")
    expect(recent()).not.toContain("Sample data")
  })

  test("a failed refresh keeps the loaded list and reports the failure", async () => {
    list.next = () => Promise.resolve([{ id: "ses_one", title: "One", status: "ready", stage: "Plan", at: 0 }])
    await act(() => actions.refreshSessions())
    list.next = () => Promise.reject(new Error("offline"))
    await act(() => actions.refreshSessions())
    await act(() => root.render(createElement(BuildPage)))
    expect(recent()).toContain("One")
    expect(recent()).toContain("Couldn't load runs.")
  })
})
