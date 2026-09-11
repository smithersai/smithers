import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { WikiGraphCardBody, WikiLinksCardBody } from "./WikiCards"

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type LinksCard = Extract<Card, { kind: "wiki-links" }>
type GraphCard = Extract<Card, { kind: "wiki-graph" }>

const links: LinksCard = {
  id: "wiki-links-plans",
  kind: "wiki-links",
  title: "Links · Plans",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    path: "Plans.md",
    title: "Plans",
    backlinks: [{ path: "World.md", title: "World" }],
    linksOut: [],
    unresolved: ["Ghost"]
  }
}

const mount = (node: React.ReactNode) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(node))
  return { host, unmount: () => flushSync(() => root.unmount()) }
}

describe("WikiLinksCardBody", () => {
  test("every note row is the button door of wiki.open with the note's path as its args; an unresolved target has no door", () => {
    const calls: Array<[string, string | undefined]> = []
    const { host, unmount } = mount(<WikiLinksCardBody card={links} onRunCommand={(name, args) => calls.push([name, args])} />)
    const backlink = host.querySelector<HTMLButtonElement>('[data-testid="wiki-open-World.md"]')
    expect(backlink?.getAttribute("data-flow")).toBe("wiki.open")
    backlink?.click()
    expect(calls).toEqual([["wiki.open", "World.md"]])
    expect(host.querySelector('[data-testid="wiki-links-links-out"]')?.textContent).toContain("No outgoing links yet")
    const unresolved = host.querySelector('[data-testid="wiki-links-unresolved"]')
    expect(unresolved?.textContent).toContain("[[Ghost]]")
    expect(unresolved?.querySelector("button")).toBeNull()
    host.querySelector<HTMLButtonElement>('[data-testid="wiki-links-open"]')?.click()
    expect(calls[1]).toEqual(["wiki.open", "Plans.md"])
    unmount()
  })
})

describe("WikiGraphCardBody", () => {
  const graph = (notes: GraphCard["payload"]["notes"], path: string | null = null): GraphCard => ({
    id: "wiki-graph",
    kind: "wiki-graph",
    title: "Wiki graph",
    status: "active",
    createdAt: 0,
    ordinal: 0,
    payload: {
      path,
      notes,
      links: notes.flatMap((note) => note.linksOut.map((target) => ({ source: note.path, target })))
    }
  })

  test("an empty Wiki says so instead of drawing nothing", () => {
    const { host, unmount } = mount(<WikiGraphCardBody card={graph([])} onRunCommand={() => {}} />)
    expect(host.querySelector('[data-testid="wiki-graph-empty"]')?.textContent).toContain("empty so far")
    unmount()
  })

  test("the scope line counts notes, links and unresolved targets, and Refresh re-runs wiki.graph with the same focus", () => {
    const calls: Array<[string, string | undefined]> = []
    const notes: GraphCard["payload"]["notes"] = [
      { path: "Plans.md", title: "Plans", linksOut: ["World.md", "Ghost.md"], backlinks: [], missing: false },
      { path: "World.md", title: "World", linksOut: [], backlinks: ["Plans.md"], missing: false },
      { path: "Ghost.md", title: "Ghost", linksOut: [], backlinks: ["Plans.md"], missing: true }
    ]
    const { host, unmount } = mount(<WikiGraphCardBody card={graph(notes, "Plans.md")} onRunCommand={(name, args) => calls.push([name, args])} />)
    expect(host.querySelector('[data-testid="wiki-graph-scope"]')?.textContent).toBe("Around Plans.md · 2 notes · 2 links · 1 unresolved")
    host.querySelector<HTMLButtonElement>('[data-testid="wiki-graph-rerun"]')?.click()
    expect(calls).toEqual([["wiki.graph", "Plans.md"]])
    unmount()
  })

  /*
   * Spec 07 §2: a scope pill names a kind of wiki content, never a surface
   * and never a store. The unfocused graph therefore reads "All", covering
   * the pages the //:wiki target generates plus the person's own notes, and
   * never "the whole Wiki", which named the store. The focused scope still
   * names a note.
   */
  test("the unfocused scope reads All, not the store's name", () => {
    const notes: GraphCard["payload"]["notes"] = [
      { path: "Plans.md", title: "Plans", linksOut: ["World.md"], backlinks: [], missing: false },
      { path: "World.md", title: "World", linksOut: [], backlinks: ["Plans.md"], missing: false }
    ]
    const { host, unmount } = mount(<WikiGraphCardBody card={graph(notes)} onRunCommand={() => {}} />)
    const scope = host.querySelector('[data-testid="wiki-graph-scope"]')?.textContent
    expect(scope).toBe("All · 2 notes · 1 link")
    expect(scope).not.toContain("whole")
    unmount()
  })
})
