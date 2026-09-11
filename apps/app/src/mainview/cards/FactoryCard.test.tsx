import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { FactoryCardBody } from "./FactoryCard"

/*
 * The factory card: the Wiki section says what exists (a generated wiki's
 * stats, the notes count, the Librarian's answers and misses) or states the
 * honest absence of each; the infra section lists every declared file with
 * its state, and a present file's Open runs files.read for that path in that
 * repository. An absent file stays a row with no Open.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const REPO = "smithersai/smithers"

type FactoryCard = Extract<Card, { kind: "factory" }>

const factoryCard = (payload: Partial<FactoryCard["payload"]>): FactoryCard => ({
  id: `factory-${REPO}`,
  kind: "factory",
  title: `Factory · ${REPO}`,
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repo: REPO,
    wiki: { generated: null, notes: 3, librarian: null },
    infra: [
      { path: ".smithers/WORKSPACE.ts", state: "present" },
      { path: "flake.nix", state: "absent" },
      { path: "PACKAGE.ts", state: "present" }
    ],
    ...payload
  }
})

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(element)
  })
  return host
}

describe("the factory card's Wiki section", () => {
  test("without a generated wiki it says so, counts the notes, and states the Librarian has no log", () => {
    const host = render(<FactoryCardBody card={factoryCard({})} onRunCommand={() => {}} />)
    expect(host.querySelector("[data-testid='factory-wiki-generated']")?.textContent).toBe("No generated wiki yet")
    expect(host.querySelector("[data-testid='factory-wiki-notes']")?.textContent).toBe("3 notes")
    expect(host.querySelector("[data-testid='factory-wiki-librarian']")?.textContent).toBe("No Librarian answers recorded yet")
    expect(host.textContent).not.toMatch(/\d+ generated page|fresh at|coverage/)
  })

  test("with a generated wiki it states the pages, the freshness sha, coverage, when, and the Librarian's answers and misses", () => {
    const host = render(
      <FactoryCardBody
        card={factoryCard({
          wiki: {
            generated: { pages: 42, sha: "862ce94", coverage: "88 % of packages covered", generatedAt: Date.now() - 2 * 60 * 60_000 },
            notes: 1,
            librarian: { answers: 212, misses: 9 }
          }
        })}
        onRunCommand={() => {}}
      />
    )
    const generated = host.querySelector("[data-testid='factory-wiki-generated']")?.textContent ?? ""
    expect(generated).toContain("42 generated pages · fresh at 862ce94 · 88 % of packages covered · last generated ")
    expect(host.querySelector("[data-testid='factory-wiki-notes']")?.textContent).toBe("1 note")
    expect(host.querySelector("[data-testid='factory-wiki-librarian']")?.textContent).toBe("Librarian · 212 answers · 9 found no note")
    expect(host.textContent).not.toContain("No generated wiki yet")
  })
})

describe("the factory card's infra section", () => {
  test("lists every declared file with its state, and only a present file offers Open", () => {
    const host = render(<FactoryCardBody card={factoryCard({})} onRunCommand={() => {}} />)
    const rows = [...host.querySelectorAll("[data-infra]")]
    expect(rows.map((row) => [row.getAttribute("data-infra"), row.getAttribute("data-state")])).toEqual([
      [".smithers/WORKSPACE.ts", "present"],
      ["flake.nix", "absent"],
      ["PACKAGE.ts", "present"]
    ])
    expect(rows[1]?.textContent).toContain("not in the repository")
    expect(rows[1]?.querySelector("button")).toBeNull()
    expect(rows[0]?.querySelector("button")?.getAttribute("data-flow")).toBe("files.read")
    expect(rows[2]?.querySelector("button")?.getAttribute("aria-label")).toBe("Open PACKAGE.ts")
  })

  test("Open runs files.read for that path in the card's repository", () => {
    const runs: Array<[string, string | undefined]> = []
    const host = render(<FactoryCardBody card={factoryCard({})} onRunCommand={(name, args) => runs.push([name, args])} />)
    const open = host.querySelector("[data-infra='.smithers/WORKSPACE.ts'] button") as HTMLButtonElement
    open.click()
    expect(runs).toEqual([["files.read", `.smithers/WORKSPACE.ts ${REPO}`]])
  })

  test("an unreadable file carries the backend's reason and no Open", () => {
    const host = render(
      <FactoryCardBody
        card={factoryCard({ infra: [{ path: "PACKAGE.ts", state: "unreadable", reason: "the mirror is rebuilding" }] })}
        onRunCommand={() => {}}
      />
    )
    const row = host.querySelector("[data-infra='PACKAGE.ts']")
    expect(row?.getAttribute("data-state")).toBe("unreadable")
    expect(row?.textContent).toContain("could not be read: the mirror is rebuilding")
    expect(row?.querySelector("button")).toBeNull()
  })
})
