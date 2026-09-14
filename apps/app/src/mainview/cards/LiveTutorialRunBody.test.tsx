import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CardSchema } from "@smthrs/rpc/Cards"
import { LiveTutorialRunBody } from "./LiveTutorialRunBody"
import type { LiveTutorialRun } from "@smthrs/rpc/LiveTutorial"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const liveCard = (snapshot: Partial<LiveTutorialRun>) => {
  const card = CardSchema.parse({ id: "live", kind: "run-trace", title: "Research", status: "active", ordinal: 1, createdAt: 1,
    payload: { repo: "practice:smithersai/hello-server", runId: "run", workflow: "issue.research", kind: "research", phase: "completed", steps: [], result: null, lastSeq: 0,
      input: { liveTutorialSnapshot: { sessionId: "session", runId: "run", operation: "research", phase: "completed", createdAt: 1, updatedAt: 2, events: [], ...snapshot } } } })
  if (card.kind !== "run-trace") throw Error("Expected run")
  return card
}

test("a completed reproduction event qualifies failed tests, while an unmarked failure stays unqualified", () => {
  const tests = { command: "npm test", exitCode: 1, output: "Hello, null!" }
  const events = [{ id: "reproduce", label: "Run the existing tests and reproduce the missing and empty name cases", status: "completed" as const, startedAt: 1, finishedAt: 2 }]
  const render = (snapshot: Partial<LiveTutorialRun>) => renderToStaticMarkup(<LiveTutorialRunBody card={liveCard(snapshot)} onRunCommand={() => {}} />)
  expect(render({ tests, events })).toContain("Tests failed (expected: reproduces the bug)")
  for (const snapshot of [{ tests }, { tests, operation: "implement" as const, events }, { tests, events: [{ ...events[0]!, status: "failed" as const }] }]) {
    const html = render(snapshot)
    expect(html).toContain("Tests failed")
    expect(html).not.toContain("expected:")
  }
  expect(render({ tests: { ...tests, exitCode: 0 }, events })).toContain("✓ Tests passed")
})

test("Start implementation has the house button anatomy and invokes its existing flow", () => {
  const card = liveCard({ operation: "plan", plan: { id: "plan", title: "Fix", summary: "Fix greeting", baseCommitId: "base", steps: ["Fix line 2"], files: ["src/hello.ts"] } })
  const host = document.createElement("div")
  const root = createRoot(host)
  const calls: unknown[] = []
  try {
    flushSync(() => root.render(<LiveTutorialRunBody card={card} onRunCommand={(...args) => { calls.push(args) }} />))
    const button = host.querySelector<HTMLButtonElement>('button[data-flow="agent.change.start"]')!
    expect(button.classList.contains("guide-button")).toBe(true)
    expect(button.querySelector(".guide-button-content")?.textContent).toBe("Start implementation")
    button.click()
    expect(calls).toEqual([["agent.change.start", "live"]])
  } finally { flushSync(() => root.unmount()) }
})

test("live research renders its markdown result through the shared renderer", () => {
  const card = CardSchema.parse({ id: "research", kind: "run-trace", title: "Research", status: "active", ordinal: 1, createdAt: 1,
    payload: { repo: "practice:smithersai/hello-server", runId: "run", workflow: "issue.research", kind: "research", phase: "completed", steps: [], result: "Evidence", lastSeq: 0,
      input: { liveTutorial: { operation: "research" }, liveTutorialSnapshot: { sessionId: "session", runId: "run", operation: "research", phase: "completed", createdAt: 1, updatedAt: 2, events: [], result: "Relevant source: **src/hello.ts**" } } } })
  if (card.kind !== "run-trace") throw new Error("Expected run card")
  expect(renderToStaticMarkup(<LiveTutorialRunBody card={card} onRunCommand={() => {}} />)).toContain("src/hello.ts")
})

test("live transcript facet renders observed details and source-qualified view controls",()=>{
 const card=CardSchema.parse({id:"live",kind:"run-trace",title:"Research",status:"active",ordinal:1,createdAt:1,payload:{repo:"practice:smithersai/hello-server",runId:"actual-run",workflow:"issue.research",kind:"research",phase:"completed",steps:[],result:null,lastSeq:1,facet:"transcript",follow:true,input:{liveTutorial:{operation:"research"},liveTutorialSnapshot:{sessionId:"session",runId:"actual-run",operation:"research",phase:"completed",createdAt:1,updatedAt:2,events:[{id:"test",label:"Run tests",status:"completed",startedAt:1,finishedAt:2,detail:"Protected assertion: empty name failed"}]}}}})
 if(card.kind!=="run-trace")throw Error("Expected run")
 const html=renderToStaticMarkup(<LiveTutorialRunBody card={card} onRunCommand={()=>{}} />)
 expect(html).toContain('aria-label="Transcript"')
 expect(html).toContain('Protected assertion: empty name failed')
 expect(html).toContain('data-flow="runs.steps"')
 expect(html).not.toContain('Write the test first')
})

test("an expired live session offers a new tutorial instead of a reconnect loop", () => {
  const card = CardSchema.parse({ id: "expired", kind: "run-trace", title: "Plan", status: "error", ordinal: 1, createdAt: 1,
    payload: { repo: "practice:smithersai/hello-server", runId: "old-run", workflow: "issue.plan", kind: "plan", phase: "stopped", steps: [], result: null, lastSeq: 0,
      observationError: "This live example session expired. Your saved results remain available.", input: { liveTutorial: { operation: "plan" } } } })
  if (card.kind !== "run-trace") throw Error("Expected run")
  const html = renderToStaticMarkup(<LiveTutorialRunBody card={card} onRunCommand={() => {}} />)
  expect(html).toContain('data-flow="onboarding.act"')
  expect(html).toContain("Start new tutorial")
  expect(html).not.toContain("Reconnect")
})
