import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createIssueFlowsController } from "./issueFlows"
import { createIssuesSeam } from "../seams/IssuesSeam"
import type { SeamContext } from "../seams/SeamContext"
import { PRACTICE_REPO } from "../practice/PracticeRepository"
async function setup() {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k,v) }, removeItem: (k: string) => { data.delete(k) } }
  const store = await createAppStore({ kind: "localStorage", storage })
  const ctx: SeamContext = { store, http: async () => { throw new Error("Practice must not fetch") }, baseUrl: "", dispatch: store.dispatch, actor: () => "user", nextOrdinal: store.nextOrdinal }
  return { store, ctx, storage }
}
test("inspect repro, then research in the same official flow card before implementation", async () => {
  const {store,ctx} = await setup()
  const flows = createIssueFlowsController(ctx, { listWorkspaceWorkflows: async () => { throw Error("offline") }, runWorkflow: async () => { throw Error("offline") } })
  expect(await flows.inspectIssueFlows(3,PRACTICE_REPO)).toEqual({ value: expect.stringContaining("Do not implement the fix") })
  const id = "practice-issue-flows-3"
  const first = store.collections.cards.get(id)
  expect(first?.kind).toBe("workflow-list")
  expect(await flows.runIssueFlow("repro",3,PRACTICE_REPO)).toEqual({ value: expect.stringContaining("not a fresh test run") })
  const researched = store.collections.cards.get(id)
  expect(researched?.ordinal).toBe(first?.ordinal)
  expect(researched?.kind === "workflow-list" && researched.payload.research).toContain("empty name")
  expect([...store.collections.cards.values()].some(card => card.kind === "run-trace")).toBe(false)
  await store.dispose?.()
})
test("practice comments and state survive reopening and reload", async () => {
  const {store,ctx,storage} = await setup()
  const issues = createIssuesSeam(ctx)
  await issues.listIssues("open",PRACTICE_REPO)
  await issues.viewIssue(3,PRACTICE_REPO)
  expect(await issues.commentOnIssue(3,"Reproduced with an empty name",PRACTICE_REPO)).toBeUndefined()
  expect(await issues.setIssueState(3,"closed",PRACTICE_REPO)).toBeUndefined()
  await issues.viewIssue(2,PRACTICE_REPO)
  await issues.viewIssue(3,PRACTICE_REPO)
  const issue = [...store.collections.cards.values()].find(c => c.kind === "issue" && c.payload.number === 3)
  expect(issue?.kind === "issue" && issue.payload.state).toBe("closed")
  expect(issue?.kind === "issue" && issue.payload.comments.at(-1)?.commentBody).toBe("Reproduced with an empty name")
  await store.dispose?.()
  const restored = await createAppStore({kind:"localStorage",storage})
  const restoredIssues = createIssuesSeam({...ctx,store:restored,dispatch:restored.dispatch})
  await restoredIssues.listIssues("open",PRACTICE_REPO)
  let list = restored.collections.cards.get("practice-issues")
  expect(list?.kind === "issue-list" && list.payload.issues.map(i=>i.number)).toEqual([2])
  await restored.dispose?.()
})
test("a live issue flow only launches an installed flow and carries the full issue context", async () => {
  const {store,ctx} = await setup()
  const issue = { number: 9, repo: "owner/repo", title: "The real issue", state: "open" as const, author: "ada", issueBody: "Details", labels: ["bug"], comments: [] }
  await store.dispatch({type:"card.upsert",actor:"user",card:{ id:"issue-live",kind:"issue",title:issue.title,status:"active",createdAt:1,ordinal:1,payload:issue }}).isPersisted.promise
  const calls: unknown[] = []
  let installed = false
  const flows = createIssueFlowsController(ctx, {
    listWorkspaceWorkflows: async () => { await store.dispatch({type:"card.upsert",actor:"user",card:{id:"catalog",kind:"workflow-list",title:"Flows",status:"active",createdAt:1,ordinal:2,payload:{repo:issue.repo,gatewayBindingVersion:1, workflows:installed ? [{key:"issue/repro",description:"Repro"}] : [{key:"review",description:"Review"}]}}}).isPersisted.promise },
    runWorkflow: async (...args) => { calls.push(args); return {value:"launched"} }
  })
  expect(await flows.runIssueFlow("repro",9,issue.repo)).toContain("not installed")
  expect(calls).toHaveLength(0)
  installed = true
  expect(await flows.runIssueFlow("repro",9,issue.repo)).toEqual({value:"launched"})
  expect(calls).toHaveLength(1)
  const [name, repo, input, source] = calls[0] as [string, string, {args:string}, string]
  expect([name,repo,source]).toEqual(["issue/repro",issue.repo,"catalog"])
  expect(JSON.parse(input.args)).toEqual({issue})
  await store.dispose?.()
})
