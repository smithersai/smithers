import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createIssueFlowsController } from "./issueFlows"
import type { SeamContext } from "../seams/SeamContext"

test("cloud implementation binds the real issue to coding/request and refuses missing or changed workspace setup", async () => {
  const values = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } } })
  const ctx: SeamContext = { store, http: async () => { throw Error("Must not use the tutorial service") }, baseUrl: "", dispatch: store.dispatch, actor: () => "user", nextOrdinal: store.nextOrdinal }
  const repo = "owner/repo", workspaceId = "11111111-1111-4111-8111-111111111111"
  const issue = { repo, number: 9, title: "Real bug", state: "open" as const, author: "ada", issueBody: "Reproduction evidence", labels: [], comments: [] }
  const calls: unknown[] = []
  let installed = false, changeScope = false, lists = 0
  const flows = createIssueFlowsController(ctx, {
    listWorkspaceWorkflows: async () => {
      lists++
      await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "coding-catalog", kind: "workflow-list", title: "Flows", status: "active", createdAt: 1, ordinal: 3,
        payload: { repo, workspaceId, gatewayBindingVersion: 1, workflows: installed ? [{ key: "coding/request", description: "Implement" }] : [{ key: "librarian/wiki", description: "Wiki" }] }
      } }).isPersisted.promise
      if (changeScope) await store.dispatch({ type: "repo.selected", actor: "user", id: repo }).isPersisted.promise
    },
    runWorkflow: async (...args) => { calls.push(args); return { value: "started" } }
  })
  // A same-number GitHub card must not satisfy the Cloud command.
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "github-issue", kind: "issue", title: "GitHub issue", status: "active", createdAt: 1, ordinal: 1, payload: { ...issue, source: "github" } } }).isPersisted.promise
  expect(await flows.runIssueFlow("repro", 9, repo)).toContain("Open Smithers Cloud issue #9")
  expect(await flows.runIssueImplementation(9, repo)).toContain("Open Smithers Cloud issue #9")
  expect(lists).toBe(0)
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "cloud-issue", kind: "issue", title: issue.title, status: "active", createdAt: 1, ordinal: 2, payload: issue } }).isPersisted.promise
  expect(await flows.runIssueImplementation(9, repo)).toContain("/workspace.open")
  expect(lists).toBe(0)
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [{ id: workspaceId, repoId: repo, name: "Coding", targetBookmark: "main", status: "running", provisioningStage: null, suspendedAt: null, createdAt: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: repo + "#workspace:" + workspaceId }).isPersisted.promise
  expect(await flows.runIssueImplementation(9, repo)).toContain("isn't configured")
  expect(calls).toHaveLength(0)
  installed = true
  expect(await flows.runIssueImplementation(9, repo)).toEqual({ value: "started" })
  expect(calls).toEqual([["coding/request", repo, { prompt: expect.stringContaining("Issue context") }, "coding-catalog"]])
  const sent = (calls[0] as [string, string, { prompt: string }, string])[2].prompt
  expect(JSON.parse(sent.slice(sent.indexOf("\n{") + 1))).toEqual(issue)
  changeScope = true
  expect(await flows.runIssueImplementation(9, repo)).toContain("changed")
  expect(calls).toHaveLength(1)
  await store.dispose?.()
})

