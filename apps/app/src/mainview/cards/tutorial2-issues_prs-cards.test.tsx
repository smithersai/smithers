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

test("practice Add flow opens the shared form with its issue and repo; submit refuses inside the card", async () => {
  const { createAppController } = await import("../state/AppController")
  const { memoryStorage, settle, unavailableAgent, unavailableRepositories } = await import("../state/TestFixtures")
  const { PRACTICE_REPO } = await import("../state/practice/PracticeRepository")
  const { IssueCardBody } = await import("./IssueCards")
  const { CardView } = await import("../ChatCards")
  const { cardActions } = await import("./CardActions")
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableRepositories, unavailableAgent)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
    await controller.commands.run("issues.view", `3 ${PRACTICE_REPO}`)
    const issue = [...store.collections.cards.values()].find(card => card.kind === "issue")!
    if (issue.kind !== "issue") throw new Error("Missing issue")
    flushSync(() => root.render(<IssueCardBody card={issue} onRunCommand={controller.runCommand} />))
    expect(host.querySelector('[data-flow="issues.link-linear"]')?.classList.contains("sui-button-outline")).toBe(true)
    const chip = host.querySelector<HTMLButtonElement>('[data-flow="issue.add-flow"]')!
    chip.focus()
    expect(document.activeElement).toBe(chip)
    chip.click()
    await settle()
    const form = store.collections.cards.get("form-issue.add-flow")
    expect(form?.kind).toBe("flow-form")
    if (form?.kind !== "flow-form") throw new Error("Missing Add flow form")
    expect(form.title).toBe("Add a flow to issue #3")
    expect(form.payload.given).toMatchObject({ number: 3, repo: PRACTICE_REPO })
    expect(form.payload.fields.find(field => field.name === "description")?.label).toBe("What should this issue flow do?")
    expect([...store.collections.toasts.values()].filter(toast => toast.status === "failed")).toEqual([])
    await controller.commands.run("form.set", `${form.id} description Research errors`)
    await controller.commands.run("form.submit", form.id)
    const refused = store.collections.cards.get(form.id)!
    expect(refused.status).toBe("error")
    flushSync(() => root.render(<CardView card={refused} maximized={false} worldDocuments={[]} {...cardActions(controller)} />))
    expect(host.textContent).toContain("Practice repositories can't take new flows yet.")
    expect([...store.collections.toasts.values()].filter(toast => toast.status === "failed")).toEqual([])
  } finally {
    flushSync(() => root.unmount()); host.remove(); await controller.dispose()
  }
})
