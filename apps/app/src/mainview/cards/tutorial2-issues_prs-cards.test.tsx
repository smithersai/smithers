import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { IssueListCardBody } from "./IssueCards"
import { LandingListCardBody } from "./LandingCards"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ControllerTestProvider } from "../ControllerContext"
import type { AppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { TutorialIssuesPrsCards } from "./tutorial2-issues_prs-cards"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
test("tutorial projects persisted list cards with the same keyboard button flow", async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } } })
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: "will/repo", org: "will", name: "repo", ownerKind: "user", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: "will/repo" }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "prs-will/repo", kind: "pr-list", title: "Pull requests · will/repo", status: "active", ordinal: 1, createdAt: 1, payload: { repo: "will/repo", landings: [{ number: 7, title: "Fix a bug", state: "open", author: null, updatedAt: null }] } } }).isPersisted.promise
  const calls: string[][] = []
  const controller = { store, runCommand: (name: string, args?: string) => calls.push(args === undefined ? [name] : [name, args]) } as unknown as AppController
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<ControllerTestProvider controller={controller}><TutorialIssuesPrsCards /></ControllerTestProvider>))
    await new Promise(resolve => setTimeout(resolve, 0))
    flushSync(() => {})
    expect(host.querySelector('[data-testid="card-prs-will/repo"]')).not.toBeNull()
    const button = host.querySelector<HTMLButtonElement>('button[data-flow="prs.view"]')!
    expect(button).not.toBeNull()
    button.focus()
    expect(document.activeElement).toBe(button)
    button.click()
    expect(calls).toEqual([["prs.view", "7 will/repo"]])
  } finally {
    flushSync(() => root.unmount())
    host.remove()
  }
})

test("both local empty cards explain the absence of a hosted tracker", () => {
  const common = { id: "local", title: "Local", status: "active" as const, ordinal: 1, createdAt: 1, body: "This local-only repository has no hosted tracker." }
  expect(renderToStaticMarkup(<IssueListCardBody card={{ ...common, kind: "issue-list", payload: { repo: "/tmp/play", filter: "open", issues: [] } }} onRunCommand={() => {}} />)).toContain("local-only repository")
  expect(renderToStaticMarkup(<LandingListCardBody card={{ ...common, kind: "pr-list", payload: { repo: "/tmp/play", landings: [] } }} onRunCommand={() => {}} />)).toContain("local-only repository")
})
