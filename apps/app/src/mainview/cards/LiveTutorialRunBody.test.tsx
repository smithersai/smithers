import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CardSchema } from "@smthrs/rpc/Cards"
import { LiveTutorialRunBody } from "./LiveTutorialRunBody"

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
