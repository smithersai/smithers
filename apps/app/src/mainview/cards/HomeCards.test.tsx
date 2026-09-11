import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { RepoHomeCardBody } from "./HomeCards"

/*
 * The home pane rendered from a fixture: every declared block renders from
 * its value and in declaration order, the CI benchmark says "not measured
 * yet" for each measure it names, the featured flows are doors onto flow.run
 * carrying the flow and the repository, an absent catalog is the honest line,
 * links are anchors, and Open PACKAGE.ts is the files.read door.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const REPO = "smithersai/smithers"

type HomeCard = Extract<Card, { kind: "repo-home" }>

const card = (payload: Partial<HomeCard["payload"]>): HomeCard => ({
  id: `repo-home-${REPO}`,
  kind: "repo-home",
  title: `Home · ${REPO}`,
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: REPO, path: ".smithers/home.json", blocks: [], featuredFlows: null, ...payload }
})

const render = (payload: Partial<HomeCard["payload"]>) => {
  const ran: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<RepoHomeCardBody card={card(payload)} onRunCommand={(name, args) => ran.push([name, args])} />)
  })
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button[data-flow]")]
  return { host, ran, buttons }
}

describe("the home card", () => {
  test("renders every declared block in order, from its value", () => {
    const { host } = render({
      blocks: [
        { type: "text", text: "Smithers builds itself with Smithers." },
        { type: "flows", title: "Try first" },
        { type: "ci-benchmark", title: "CI on Smithers", measures: ["cold", "incremental", "cache-hit-rate"] },
        { type: "links", title: "Read more", links: [{ label: "Source on GitHub", url: "https://github.com/smithersai/smithers" }] }
      ],
      featuredFlows: [{ id: "review", summary: "Review the change." }]
    })
    expect([...host.querySelectorAll<HTMLElement>("[data-block]")].map((section) => section.dataset.block)).toEqual([
      "text",
      "flows",
      "ci-benchmark",
      "links"
    ])
    expect(host.querySelector('[data-testid="home-text"]')?.textContent).toBe("Smithers builds itself with Smithers.")
    expect([...host.querySelectorAll("h4")].map((heading) => heading.textContent)).toEqual(["Try first", "CI on Smithers", "Read more"])
    const link = host.querySelector<HTMLAnchorElement>('[data-testid="home-links"] a')
    expect(link?.textContent).toBe("Source on GitHub")
    expect(link?.getAttribute("href")).toBe("https://github.com/smithersai/smithers")
    expect(link?.getAttribute("rel")).toBe("noreferrer")
  })

  test("the CI benchmark names each measure it asked for and says not measured yet", () => {
    const { host } = render({ blocks: [{ type: "ci-benchmark", measures: ["cold", "cache-hit-rate"] }] })
    const rows = [...host.querySelectorAll<HTMLTableRowElement>('[data-testid="home-ci-benchmark"] tr')]
    expect(rows.map((row) => [row.dataset.measure, ...[...row.cells].map((cell) => cell.textContent)])).toEqual([
      ["cold", "Cold, full", "not measured yet"],
      ["cache-hit-rate", "Cache hits", "not measured yet"]
    ])
    expect(host.textContent).not.toContain("One-file change")
    expect(host.textContent).not.toMatch(/\d+ ?(m|s|%)/)
  })

  test("the featured flows are doors onto flow.run carrying the flow and the repository, with the catalog's summary", () => {
    const { host, ran, buttons } = render({
      blocks: [{ type: "flows" }],
      featuredFlows: [{ id: "review", summary: "Review the change." }, { id: "lint", summary: null }]
    })
    const doors = buttons().filter((button) => button.dataset.flow === "flow.run")
    expect(doors.map((button) => button.textContent)).toEqual(["/review", "/lint"])
    expect(host.querySelector('[data-testid="home-flows"]')?.textContent).toContain("Review the change.")
    for (const door of doors) door.click()
    expect(ran).toEqual([["flow.run", `review ${REPO}`], ["flow.run", `lint ${REPO}`]])
  })

  test("without a factory projection the flows block says so and offers no door", () => {
    const { host, buttons } = render({
      blocks: [{ type: "flows", title: "Try first" }],
      featuredFlows: null,
      featuredReason: `${REPO} has no .smithers/factory.json, so its featured flows are not published yet.`
    })
    expect(host.querySelector('[data-testid="home-no-flows"]')?.textContent).toBe(
      `${REPO} has no .smithers/factory.json, so its featured flows are not published yet.`
    )
    expect(buttons().map((button) => button.dataset.flow)).toEqual(["files.read"])
  })

  test("Open FACTORY.ts is the files.read door onto the declaring file", () => {
    const { host, ran, buttons } = render({ blocks: [{ type: "text", text: "x" }] })
    expect(host.querySelector('[data-testid="home-source"]')?.textContent).toContain(".smithers/home.json")
    expect(host.querySelector('[data-testid="home-source"]')?.textContent).toContain(".smithers/FACTORY.ts")
    const [door] = buttons()
    expect(door?.dataset.flow).toBe("files.read")
    door?.click()
    expect(ran).toEqual([["files.read", `.smithers/FACTORY.ts ${REPO}`]])
  })
})
