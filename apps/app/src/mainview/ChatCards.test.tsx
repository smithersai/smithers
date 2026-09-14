import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { CardView, type CardViewProps } from "./ChatCards"
import { CardSchema } from "@smthrs/rpc/Cards"
import { practiceIssue } from "./state/practice/PracticeRepository"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const noop = () => {}
const issue = CardSchema.parse({ id: "issue", kind: "issue", title: "Issue", status: "active", ordinal: 1, createdAt: 1, payload: practiceIssue(3) })
const props: CardViewProps = { card: issue, maximized: false, onMaximize: noop, onMinimize: noop, onOpenInTab: noop,
  onDecideApproval: noop, onGrantConfirm: noop, onGrantCancel: noop, onQueueApprove: noop, onConnectGitHub: noop,
  onConnectLocal: noop, onRunWorkflow: noop, onStopRun: noop, onRetryRun: noop, onChooseWorkflowRepo: noop,
  worldDocuments: [], onChangeWorldDocument: noop, onRunCommand: noop }
const mount = (overrides: Partial<CardViewProps> = {}, onKeyDown = noop) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = (more: Partial<CardViewProps>) => flushSync(() => root.render(<div onKeyDown={onKeyDown}><CardView {...props} {...overrides} {...more} /></div>))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  render({})
  return { host, render }
}

test("Escape restores the same card through its minimize callback and does not escape into the guide", () => {
  let minimizations = 0
  let escaped = 0
  const { host, render } = mount({ onMinimize: () => { minimizations++; render({ maximized: false }) } }, () => { escaped++ })
  const card = host.querySelector(".smithers-card")!
  const body = card.querySelector(".smithers-card-body")
  render({ maximized: true })
  flushSync(() => card.querySelector('button[data-flow="card.minimize"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
  expect(minimizations).toBe(1)
  expect(escaped).toBe(0)
  expect(host.querySelector(".smithers-card")).toBe(card)
  expect(card.querySelector(".smithers-card-body")).toBe(body)
  expect(card.getAttribute("data-maximized")).toBe("false")
  expect(host.querySelector(".card-maximize-backdrop")).toBeNull()
})

test("a maximized frame with local history has one navigation pair bound to that history", () => {
  const calls: unknown[] = []
  const { host } = mount({ maximized: true, card: { ...issue, navigation: { index: 1, length: 2 } }, onRunCommand: (...args) => { calls.push(args) } })
  expect(host.querySelectorAll(".smithers-card-header")).toHaveLength(1)
  expect(host.querySelectorAll(".card-maximize-backdrop")).toHaveLength(1)
  expect(host.querySelectorAll('[data-flow="frame.back"], [data-flow="frame.forward"]')).toHaveLength(0)
  host.querySelector<HTMLButtonElement>('[data-flow="card.history.back"]')!.click()
  expect(calls).toEqual([["card.history.back", "issue"]])
})

test("an Open issue has no internal DONE details; completed runs retain their Details", () => {
  const { host, render } = mount()
  expect(host.textContent).toContain("Open")
  expect(host.querySelector(".smithers-card-details")).toBeNull()
  const run = CardSchema.parse({ id: "run", kind: "run-trace", title: "Run", status: "active", ordinal: 1, createdAt: 1,
    payload: { repo: "practice:smithersai/hello-server", runId: "run", workflow: "issue.research", kind: "research", phase: "completed", steps: [], result: null, lastSeq: 0 } })
  render({ card: run })
  expect(host.querySelector(".smithers-card-details")?.textContent).toContain("Status")
  expect(host.querySelector(".smithers-card-details")?.textContent).toContain("Created")
})
