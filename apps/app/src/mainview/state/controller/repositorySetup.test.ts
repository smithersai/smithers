import { expect, spyOn, test } from "bun:test"
import { initialSetup, setupCandidate, type RepositorySetup, type SetupManualRequest, type SetupDraft, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import { createAppStore } from "../AppStore"
import { memoryStorage, recordingAgent, unavailableRepositories } from "../TestFixtures"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { ControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createRepositorySetupController, projectRecoveredSetup, type RepositorySetupDependencies } from "./repositorySetup"
import { cardContainsRun, runScopeFromCard } from "../RunReference"
import { PRACTICE_REPO } from "../practice/PracticeRepository"

type Body = { requestId: string; repo: string; job: string; revision: number; digest: string; draft: SetupDraft; workspaceId?: string; manual?: SetupManualRequest }
const workspaceId = "de29f26b-e593-4ec2-99fc-583d4711f20a"
const response = (body: Body, phase = "completed", operation = "evaluate") => Response.json({
  requestId: body.requestId, revision: body.revision, digest: body.digest, workspaceId,
  receipt: { requestId: body.requestId, runId: "run-1", revision: body.revision, digest: body.digest,
    operation, phase, updatedAt: 1, results: [], evidence: ["run:run-1"], ...(phase === "failed" ? { error: "Model unavailable" } : {}) }
})
const deferred = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}
async function fixture(answer: (body: Body, method: string) => Promise<Response>, storage = memoryStorage(), dependencies?: RepositorySetupDependencies) {
  const store = await createAppStore({ kind: "localStorage", storage })
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maintainer", allowlisted: true, admin: false, scopesPlain: null })
  if (!store.collections.cards.get("setup")) await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id: "setup", kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: store.nextOrdinal(),
    payload: { ...initialSetup("example/repo", "issues", "maintainer"), inspectedAt: 1 }
  } }).isPersisted.promise
  const calls: Array<{ method: string; body: Body }> = []
  const recovery = { calls: [] as string[], answer: async (repo: string, job: string): Promise<Response> => Response.json({ owner: "maintainer", repo, job, registration: { state: "known" }, setup: { state: "none" } }) }
  const disposers: Array<() => void> = []
  const background: Promise<unknown>[] = []
  let previous: Body
  const ctx = { store, commandActor: "user", baseUrl: "", workflowPollMs: 5, toastRuns: new Map(),
    toastDebounceMs: 5, toastAutoDismissMs: 10000, accountEpoch: 0, disposed: false, unref: () => {},
    onDispose: (close: () => void) => { disposers.push(close) },
    errorMessageOf: async () => "The host refused the request.",
    boundedFetch: async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      if (_url.includes("/state?")) {
        recovery.calls.push(_url)
        const url = new URL(_url, "https://app.test")
        return recovery.answer(url.searchParams.get("repo")!, url.searchParams.get("job")!)
      }
      const selected = _url.includes("/observe?") ? [...store.collections.cards.values()].find(card => card.kind === "repository-setup" && card.payload.request?.id === new URL(_url, "https://app.test").searchParams.get("requestId")) : undefined
      const observed = selected?.kind === "repository-setup" ? selected.payload : undefined
      const body = init?.body ? JSON.parse(String(init.body)) as Body : observed?.request ? {
        requestId: observed.request.id, repo: observed.repo, job: observed.job, revision: observed.request.revision, digest: observed.request.digest, draft: observed.draft, workspaceId: observed.workspaceId
      } : previous!
      previous = body
      calls.push({ method, body })
      return answer(body, method)
    }
  } as unknown as ControllerContext
  const failures = createFailureController(ctx)
  ctx.withToast = ((...args: Parameters<typeof failures.withToast>) => {
    const work = failures.withToast(...args); background.push(work); return work
  }) as typeof ctx.withToast
  const setup = createRepositorySetupController(ctx, dependencies)
  const state = () => (store.collections.cards.get("setup") as { payload: RepositorySetup }).payload
  const close = async () => { disposers.forEach(dispose => dispose()); await store.settled?.(); await store.dispose?.() }
  return { store, storage, calls, recovery, background, setup, state, close, ctx }
}

const doors = (overrides: Partial<RepositorySetupDependencies> = {}): RepositorySetupDependencies => ({
  promptSignIn: () => {}, chooseRepository: async () => {}, openRun: async () => {}, send: async () => true, guidanceFailed: () => {}, ...overrides
})

test("setup acknowledges persisted intent before launch, deduplicates it, and keeps Chat usable", async () => {
  const gate = deferred()
  const t = await fixture(async body => { await gate.promise; return response(body) })
  try {
    const result = await Promise.race([t.setup.runRepositorySetup("setup", "evaluate"), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
    expect(result).not.toBe("blocked")
    expect(t.state().request?.state).toBe("requested")
    await t.setup.runRepositorySetup("setup", "evaluate")
    expect(t.calls).toHaveLength(1)
    await t.setup.viewRepositorySetup("setup", "prompts", "research")
    expect(t.state().view).toBe("prompts")
    expect(t.store.session().phase).not.toBe("responding")
    await until(() => [...t.store.collections.toasts.values()].some(toast => toast.status === "running"))
    gate.release(); await Promise.all(t.background)
    expect(t.state().request?.state).toBe("completed")
    expect([...t.store.collections.toasts.values()].map(toast => toast.status)).toEqual(["ok"])
  } finally { gate.release(); await t.close() }
})

test("a launch acknowledgment never resolves the toast before the remote execution completes", async () => {
  const gate = deferred()
  const t = await fixture(async (body, method) => {
    if (method === "POST") return response(body, "running")
    await gate.promise; return response(body)
  })
  try {
    await t.setup.runRepositorySetup("setup", "evaluate")
    await until(() => t.calls.some(call => call.method === "GET"))
    expect(t.state().evaluation?.phase).toBe("running")
    expect([...t.store.collections.toasts.values()].map(toast => toast.status)).toEqual(["running"])
    gate.release(); await Promise.all(t.background)
    expect(t.state().evaluation?.phase).toBe("completed")
  } finally { gate.release(); await t.close() }
})

test("a lost response stays visibly retryable and reuses the durable request id", async () => {
  let lost = true
  const t = await fixture(async body => { if (lost) throw Error("Connection lost"); return response(body) })
  try {
    await t.setup.runRepositorySetup("setup", "evaluate"); await Promise.all(t.background)
    const id = t.state().request!.id
    expect(t.state().request?.error).toBe("Connection lost")
    expect(t.state().active).toBeUndefined()
    lost = false
    await t.setup.retryRepositorySetup("setup"); await Promise.all(t.background)
    expect(t.calls.map(call => call.body.requestId)).toEqual([id, id])
    expect(t.state().request?.state).toBe("completed")
  } finally { await t.close() }
})

test("a known execution failure stays in evidence history while an explicit retry gets a new attempt", async () => {
  const t = await fixture(async body => response(body, "failed"))
  try {
    await t.setup.runRepositorySetup("setup", "evaluate"); await Promise.all(t.background)
    const id = t.state().request!.id
    expect(t.state().previousReceipts[0]?.requestId).toBe(id)
    await t.setup.retryRepositorySetup("setup"); await Promise.all(t.background)
    expect(t.state().request!.id).not.toBe(id)
  } finally { await t.close() }
})

test("editing a prompt ignores a late response, preserves the active version, and invalidates only the draft", async () => {
  const gate = deferred()
  const t = await fixture(async body => { await gate.promise; return response(body) })
  try {
    const state = t.state()
    const card = t.store.collections.cards.get("setup")!
    const active = { revision: 1, digest: setupCandidate(state), registrationId: "active-1", sourceRevision: "commit-1", enabled: true }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: { ...state, active } } }).isPersisted.promise
    await t.setup.runRepositorySetup("setup", "evaluate")
    await t.setup.configureRepositorySetup("setup", "step.research.prompt", "A changed prompt")
    gate.release(); await Promise.all(t.background)
    expect(t.state().revision).toBe(2)
    expect(t.state().evaluation).toBeUndefined()
    expect(t.state().active).toEqual(active)
  } finally { gate.release(); await t.close() }
})

test("reload reconnects the same persisted request without granting it success", async () => {
  const gate = deferred()
  const first = await fixture(async body => { await gate.promise; return response(body) })
  await first.setup.runRepositorySetup("setup", "evaluate")
  const id = first.state().request!.id
  await first.close()
  gate.release(); await Promise.all(first.background)
  const second = await fixture(async body => response(body), first.storage)
  try {
    expect(second.state().request?.state).toBe("requested")
    second.setup.resumeRepositorySetups(); await until(() => second.state().request?.state === "completed")
    expect(second.calls[0]?.body.requestId).toBe(id)
    expect(second.state().request?.state).toBe("completed")
  } finally { await second.close() }
})

test("draft commands cannot forge active authority or run as another account", async () => {
  const t = await fixture(async body => response(body))
  try {
    expect(await t.setup.configureRepositorySetup("setup", "active", true)).toBe("That setting cannot be edited.")
    const prior = t.store.collections.cards.get("setup")!
    t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", allowlisted: true, admin: false, scopesPlain: null })
    // Account switching already clears old cards; a restored foreign card is
    // refused by the controller independently of that presentation policy.
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: prior }).isPersisted.promise
    expect(await t.setup.runRepositorySetup("setup", "evaluate")).toBe("This setup belongs to a different account.")
    expect(t.calls).toHaveLength(0)
  } finally { await t.close() }
})

test("queued admission creates no synthetic run; the real observed run opens in its recorded workspace", async () => {
  const observation = deferred(), runRead = deferred()
  const opened: unknown[][] = []
  let polls = 0
  const t = await fixture(async (body, method) => {
    if (method === "POST") {
      const queued = await response(body, "queued").json()
      delete queued.receipt.runId
      return Response.json(queued)
    }
    await observation.promise
    if (polls++ === 0) return response(body, "running")
    throw Error("Connection lost")
  }, memoryStorage(), doors({ openRun: async (...args) => { opened.push(args); await runRead.promise } }))
  try {
    await t.setup.runRepositorySetup("setup", "evaluate")
    await until(() => t.calls.some(call => call.method === "GET"))
    expect(t.state().receipt?.runId).toBeUndefined()
    expect(opened).toEqual([])
    observation.release()
    await Promise.all(t.background)
    expect(opened).toEqual([["run-1", "example/repo", "setup"]])
    expect(t.state().request?.state).toBe("failed")
    expect(t.state().receipt?.phase).toBe("running")
    expect(t.state().evaluation?.phase).toBe("running")
    const card = t.store.collections.cards.get("setup")!
    expect(cardContainsRun(card, "run-1")).toBe(true)
    expect(cardContainsRun(card, "invented")).toBe(false)
    expect(runScopeFromCard(t.store, card, "run-1")).toEqual({ repo: "example/repo", runId: "run-1", workspaceId })
  } finally { observation.release(); runRead.release(); await t.close() }
})

test("a result for another workspace is refused without replacing the last run phase", async () => {
  const t = await fixture(async (body, method) => {
    const value = await response(body, "running").json()
    return Response.json({ ...value, workspaceId: method === "POST" ? workspaceId : "1201d1d3-6d38-4b65-9d91-f502d7b7377a" })
  })
  try {
    await t.setup.runRepositorySetup("setup", "evaluate"); await Promise.all(t.background)
    expect(t.state().request?.error).toBe("The host returned a result for a different workspace.")
    expect(t.state().receipt?.phase).toBe("running")
    expect(t.state().workspaceId).toBe(workspaceId)
  } finally { await t.close() }
})

test("signed-out setup stays editable and offers the sign-in door without inspecting", async () => {
  let signIns = 0
  const t = await fixture(async body => response(body), memoryStorage(), doors({ promptSignIn: () => { signIns++ } }))
  try {
    t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null })
    await t.setup.openRepositorySetup("issues", "example/preview")
    expect(signIns).toBe(0)
    const card = [...t.store.collections.cards.values()].find(card => card.kind === "repository-setup")!
    await t.setup.configureRepositorySetup(card.id, "replies", "draft")
    await t.setup.runRepositorySetup(card.id, "inspect")
    expect(signIns).toBe(1)
    expect(t.calls).toEqual([])
    expect(card.kind === "repository-setup" && card.payload.request).toBeUndefined()
  } finally { await t.close() }
})

test("signed-in practice setup offers the real repository chooser without provisioning practice", async () => {
  let choices = 0
  const t = await fixture(async body => response(body), memoryStorage(), doors({ chooseRepository: async () => { choices++ } }))
  try {
    await t.setup.openRepositorySetup("ci", PRACTICE_REPO)
    expect(choices).toBe(1)
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})

test("human setup starts Chat only after repository inspection and preserves a typed draft", async () => {
  const inspection = deferred()
  const messages: string[] = []
  const t = await fixture(async body => {
    await inspection.promise
    return Response.json({ ...await response(body, "completed", "inspect").json(), inspection: {
      sources: [{ path: ".github/workflows/ci.yml", status: "read", summary: "Tests already run for every pull request.", revision: "source-1" }],
      suggestedDraft: initialSetup(body.repo, "ci", "maintainer").draft, inspectedAt: 2
    } })
  }, memoryStorage(), doors({ send: async text => { messages.push(text); return true } }))
  try {
    t.store.dispatch({ type: "composer.changed", actor: "user", draft: "Keep my unfinished question" })
    await t.setup.openRepositorySetup("ci", "example/another")
    expect(messages).toEqual([])
    inspection.release(); await Promise.all(t.background)
    expect(messages).toEqual([])
    expect(t.store.session().draft).toBe("Keep my unfinished question")
    t.store.dispatch({ type: "composer.changed", actor: "user", draft: "" })
    await until(() => messages.length === 1)
    const card = [...t.store.collections.cards.values()].find(card => card.kind === "repository-setup" && card.payload.repo === "example/another")!
    expect(messages[0]).toContain(`setup.guide for card ${card.id}`)
    expect(card.kind === "repository-setup" && card.payload.sources[0]?.revision).toBe("source-1")
    await t.setup.openRepositorySetup("ci", "example/another")
    expect(messages).toHaveLength(1)
  } finally { inspection.release(); await t.close() }
})

test("inspection receipt history stays completed through the suggested revision and restart", async () => {
  const inspection = deferred()
  const t = await fixture(async (body, method) => {
    if (method === "POST") return response(body, "running", "inspect")
    await inspection.promise
    return Response.json({ ...await response(body, "completed", "inspect").json(), inspection: {
      sources: [{ path: "README.md", status: "read", summary: "Repository usage" }], inspectedAt: 2,
      suggestedDraft: { ...body.draft, cases: [
        { id: "usage", name: "Usage question", input: "How does this repository work?", expected: "Cite README.md", required: true },
        { id: "unknown", name: "Missing detail", input: "An unspecified problem", expected: "Ask for the missing detail", required: true }
      ] }
    } })
  })
  let requestId = ""
  try {
    await t.setup.runRepositorySetup("setup", "inspect")
    await until(() => t.state().receipt?.phase === "running")
    requestId = t.state().request!.id
    inspection.release(); await Promise.all(t.background)
    expect(t.state()).toMatchObject({ revision: 2, request: { id: requestId, state: "completed" }, draft: { cases: [{ id: "usage" }, { id: "unknown" }] } })
    expect(t.state().previousReceipts).toEqual([t.state().receipt!])
    expect(t.state().previousReceipts[0]?.phase).toBe("completed")
  } finally { inspection.release(); await t.close() }
  const restored = await fixture(async body => response(body), t.storage)
  try {
    await restored.setup.runRepositorySetup("setup", "evaluate")
    await Promise.all(restored.background)
    expect(restored.calls.filter(call => call.method === "POST")).toHaveLength(1)
    expect(restored.state().request?.id).not.toBe(requestId)
    expect(restored.state().previousReceipts.find(item => item.requestId === requestId)).toMatchObject({ operation: "inspect", phase: "completed", revision: 1 })
  } finally { await restored.close() }
})

test("inspection receipt history heals from an available receipt before a later operation replaces it", async () => {
  const evaluation = deferred()
  const t = await fixture(async (body, method) => {
    if (method === "POST") return response(body, "running")
    await evaluation.promise
    return response(body)
  })
  try {
    const card = t.store.collections.cards.get("setup")!
    const completed = (await response({ requestId: "old-inspection", repo: t.state().repo, job: "issues", revision: 1, digest: "old-digest", draft: t.state().draft }, "completed", "inspect").json()).receipt
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: {
      ...t.state(), revision: 2, receipt: completed,
      previousReceipts: [{ ...completed, phase: "running" }, { ...completed, requestId: "unobserved-request", phase: "running" }]
    } } }).isPersisted.promise
    await t.setup.runRepositorySetup("setup", "evaluate")
    await until(() => t.state().receipt?.operation === "evaluate")
    expect(t.state().receipt?.phase).toBe("running")
    expect(t.state().previousReceipts.find(item => item.requestId === "old-inspection")).toEqual(completed)
    expect(t.state().previousReceipts.find(item => item.requestId === "unobserved-request")?.phase).toBe("running")
    evaluation.release(); await Promise.all(t.background)
  } finally { evaluation.release(); await t.close() }
})

test("the agent guidance door reads current prompts and evidence without launching a nested turn", async () => {
  const messages: string[] = []
  const t = await fixture(async body => response(body), memoryStorage(), doors({ send: async text => { messages.push(text); return true } }))
  try {
    const guide = createRepositorySetupController({ ...t.ctx, commandActor: "smithers" }, doors({ send: async text => { messages.push(text); return true } }))
    await t.setup.configureRepositorySetup("setup", "step.research.prompt", "Read the repository's request handlers first.")
    const result = await guide.guideRepositorySetup("setup")
    expect(typeof result === "object" && result.value).toContain("Read the repository's request handlers first.")
    expect(typeof result === "object" && result.value).toContain("one short repository-informed question")
    expect(messages).toEqual([])
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})

test("a second explicit guide remains queued while the first durable admission is held", async () => {
  const held = deferred(), messages: string[] = []
  const t = await fixture(async body => response(body), memoryStorage(), doors({ send: async text => {
    messages.push(text)
    if (messages.length === 1) await held.promise
    return true
  } }))
  try {
    await t.store.dispatch({ type: "card.upsert", actor: "user", card: { id: "other-setup", kind: "repository-setup", title: "Review pull requests", status: "active", createdAt: 2, ordinal: t.store.nextOrdinal(),
      payload: { ...initialSetup("example/repo", "review", "maintainer"), inspectedAt: 1 }
    } }).isPersisted.promise
    await t.setup.guideRepositorySetup("setup")
    await until(() => messages.length === 1)
    await t.setup.guideRepositorySetup("other-setup")
    expect(messages).toHaveLength(1)
    held.release()
    await until(() => messages.length === 2)
    expect(messages[0]).toContain("card setup")
    expect(messages[1]).toContain("card other-setup")
  } finally { held.release(); await t.close() }
})

test("new setup ignores an ambient older workspace and keeps the server's compatible binding", async () => {
  const t = await fixture(async body => response(body, "failed", "inspect"))
  try {
    const other = "1201d1d3-6d38-4b65-9d91-f502d7b7377a"
    await t.store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [workspaceId, other].map(id => ({
      id, repoId: "example/repo", name: "Box", targetBookmark: null, status: "running", provisioningStage: null, suspendedAt: null, createdAt: null
    })) }).isPersisted.promise
    await t.store.dispatch({ type: "repo.selected", actor: "user", id: `example/repo#workspace:${other}` }).isPersisted.promise
    await t.setup.openRepositorySetup("ci", "example/repo"); await Promise.all(t.background)
    expect(t.calls[0]?.body.workspaceId).toBeUndefined()
    await t.store.dispatch({ type: "repo.selected", actor: "user", id: `example/repo#workspace:${other}` }).isPersisted.promise
    await t.setup.openRepositorySetup("ci", "example/repo")
    const card = [...t.store.collections.cards.values()].find(card => card.kind === "repository-setup" && card.payload.job === "ci")!
    expect(card.kind === "repository-setup" && card.payload.workspaceId).toBe(workspaceId)
    await t.setup.configureRepositorySetup(card.id, "step.checks.prompt", "Run this repository's existing checks.")
    await t.setup.runRepositorySetup(card.id, "inspect"); await Promise.all(t.background)
    expect(t.calls[1]?.body.workspaceId).toBe(workspaceId)
    expect(t.calls[1]?.body.revision).toBe(2)
    await t.close()
    const again = await fixture(async body => response(body, "failed", "inspect"), t.storage)
    try {
      await again.setup.openRepositorySetup("ci", "example/repo"); await Promise.all(again.background)
      await again.setup.retryRepositorySetup(card.id); await Promise.all(again.background)
      expect(again.calls).toHaveLength(1)
      expect(again.calls[0]?.body.workspaceId).toBe(workspaceId)
      await again.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      expect(runScopeFromCard(again.store, card, "run-1")).toBeUndefined()
    } finally { await again.close() }
  } finally { await t.close() }
})

test("PR trials require a real selector and immediate launch uses both ordered field edits", async () => {
  const t = await fixture(async body => response(body, "completed", "trial"))
  try {
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: initialSetup("example/repo", "review", "maintainer") } }).isPersisted.promise
    expect(await t.setup.runRepositorySetup("setup", "trial")).toBe("Choose a PR for this trial.")
    expect(t.calls).toHaveLength(0)
    const changes = [t.setup.configureRepositorySetup("setup", "trial.source", "smithers-cloud"), t.setup.configureRepositorySetup("setup", "trial.number", 42)]
    await t.setup.runRepositorySetup("setup", "trial")
    await Promise.all([...changes, ...t.background])
    expect(t.calls).toHaveLength(1)
    expect(JSON.parse(t.calls[0]!.body.draft.trialBody)).toEqual({ source: "smithers-cloud", number: 42 })
    expect(t.calls[0]!.body.revision).toBe(3)
  } finally { await t.close() }
})

test("pausing retains evidence and advances the candidate before any reactivation", async () => {
  const t = await fixture(async body => {
    const value = await response(body, "completed", "pause").json()
    return Response.json({ ...value, receipt: { ...value.receipt, registrationId: "active-1", sourceRevision: "commit-1" } })
  })
  try {
    const card = t.store.collections.cards.get("setup")!
    const digest = setupCandidate(t.state())
    const evidence = { runId: "prior-run", revision: 1, digest, phase: "completed" as const, updatedAt: 1, results: [], evidence: ["artifact:prior-results"], sourceRevision: "commit-1" }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: { ...t.state(),
      evaluation: { ...evidence, requestId: "eval-1", operation: "evaluate" },
      trial: { ...evidence, requestId: "trial-1", operation: "trial" },
      active: { revision: 1, digest, registrationId: "active-1", sourceRevision: "commit-1", enabled: true }
    } } }).isPersisted.promise
    await t.setup.runRepositorySetup("setup", "pause"); await Promise.all(t.background)
    expect(t.state().active).toMatchObject({ revision: 1, enabled: false })
    expect(t.state().revision).toBe(2)
    expect(setupCandidate(t.state())).not.toBe(digest)
    expect(t.state().evaluation).toBeUndefined()
    expect(t.state().trial).toBeUndefined()
    expect(t.state().previousReceipts.map(receipt => receipt.requestId)).toEqual(["eval-1", "trial-1"])
    expect(t.state().receipt?.operation).toBe("pause")
    expect(await t.setup.runRepositorySetup("setup", "apply")).toContain("Run evals for this draft")
    expect(t.calls).toHaveLength(1)
  } finally { await t.close() }
})

test("chore apply refreshes the registry in the background; held duplicate input, edits, pause and restart cannot reuse its old next run", async () => {
  const held = deferred()
  let operation = "apply"
  const t = await fixture(async body => {
    const value = await response(body, "completed", operation).json()
    return Response.json({ ...value, receipt: { ...value.receipt, registrationId: "chore-registration", sourceRevision: "commit-1" } })
  })
  try {
    const card = t.store.collections.cards.get("setup")!
    const payload = { ...initialSetup("example/repo", "chores", "maintainer"), inspectedAt: 1 }
    payload.draft.schedule = "0 9 * * *"
    payload.draft.steps[0]!.mode = "automatic"
    payload.draft.cases = [{ id: "check", name: "A maintenance change", input: "synthetic case fixture", expected: "A checked proposal", required: true }]
    const digest = setupCandidate(payload)
    const proof = { revision: 1, digest, phase: "completed" as const, updatedAt: 1, results: [{ caseId: "check", status: "passed" as const, observed: "A checked proposal", evidence: ["test:check"], executionId: "eval-case" }], evidence: ["artifact:checked"], sourceRevision: "commit-1" }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, kind: "repository-setup", payload: { ...payload,
      evaluation: { ...proof, requestId: "eval", runId: "eval-run", operation: "evaluate" }, trial: { ...proof, requestId: "trial", runId: "trial-run", operation: "trial" }
    } } }).isPersisted.promise
    const policy = { revision: 1, digest, registrationId: "chore-registration", sourceRevision: "commit-1", enabled: true, owned: true, workspaceId, draft: payload.draft,
      schedule: { expression: "0 9 * * *", nextFireAt: "2026-09-18T09:00:00Z" } }
    t.recovery.answer = async () => { await held.promise; return Response.json({ owner: "maintainer", repo: payload.repo, job: "chores", registration: { state: "known", active: policy }, setup: { state: "none" } }) }
    const acknowledgment = await Promise.race([t.setup.runRepositorySetup("setup", "apply"), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))])
    expect(acknowledgment).not.toBe("blocked")
    await until(() => t.recovery.calls.length === 1)
    expect(t.state().request?.state).toBe("completed")
    expect(t.state().active?.schedule).toBeUndefined()
    expect(t.state().recovery?.state).toBe("requested")
    await t.setup.runRepositorySetup("setup", "apply")
    expect(t.calls).toHaveLength(1)
    expect(t.recovery.calls).toHaveLength(1)
    await t.setup.viewRepositorySetup("setup", "flows")
    await t.setup.configureRepositorySetup("setup", "schedule", "0 10 * * *")
    held.release()
    await until(() => t.state().recovery?.state === "completed")
    expect(t.state().draft.schedule).toBe("0 10 * * *")
    expect(t.state().active?.schedule).toEqual(policy.schedule)
    expect(t.state().revision).toBe(2)
    expect(t.store.session().phase).toBe("idle")
    operation = "pause"
    await t.setup.runRepositorySetup("setup", "pause")
    await until(() => t.state().receipt?.operation === "pause")
    expect(t.state().active?.enabled).toBe(false)
    expect(t.state().active?.schedule).toBeUndefined()
    expect(t.calls.map(call => call.method)).toEqual(["POST", "POST"])
    await t.close()
    const again = await fixture(async () => { throw Error("Recovery must not execute") }, t.storage)
    try {
      again.recovery.answer = async () => Response.json({ owner: "maintainer", repo: payload.repo, job: "chores", registration: { state: "known", active: { ...policy, enabled: false, schedule: undefined } }, setup: { state: "none" } })
      again.setup.resumeRepositorySetups()
      await until(() => again.state().recovery?.state === "completed")
      expect(again.state().active?.enabled).toBe(false)
      expect(again.state().active?.schedule).toBeUndefined()
      expect(again.state().draft.schedule).toBe("0 10 * * *")
      expect(again.calls).toEqual([])
    } finally { await again.close() }
  } finally { held.release(); await t.close() }
})

test.each(["elapsed", "future", "failed"])("an open chore expires its observed time and makes one bounded %s refresh without blocking Chat", async outcome => {
  let now = Date.UTC(2026, 8, 17, 9)
  const due = now + 60_000, clock = spyOn(Date, "now").mockImplementation(() => now)
  const originalTimeout = globalThis.setTimeout, scheduled: Array<() => void> = []
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 60_000) scheduled.push(() => callback(...args))
    return originalTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  const held = deferred(), t = await fixture(async () => { throw Error("A schedule read cannot execute work") })
  try {
    const payload = { ...initialSetup("example/repo", "chores", "maintainer"), inspectedAt: 1 }
    payload.draft.schedule = "* * * * *"
    const policy = { revision: 1, digest: setupCandidate(payload), registrationId: "scheduled", sourceRevision: "source", enabled: true, owned: true, workspaceId, draft: payload.draft,
      schedule: { expression: payload.draft.schedule, nextFireAt: new Date(due).toISOString() } }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...t.store.collections.cards.get("setup")!, kind: "repository-setup", payload } }).isPersisted.promise
    t.recovery.answer = async () => {
      if (t.recovery.calls.length > 1) {
        await held.promise
        if (outcome === "failed") return Response.json({}, { status: 503 })
        if (outcome === "future") policy.schedule.nextFireAt = new Date(due + 60_000).toISOString()
      }
      return Response.json({ owner: "maintainer", repo: payload.repo, job: "chores", registration: { state: "known", active: policy }, setup: { state: "none" } })
    }
    t.setup.resumeRepositorySetups()
    await until(() => scheduled.length === 1)
    expect(t.state().active?.schedule?.nextFireAt).toBe(new Date(due).toISOString())
    now = due
    scheduled[0]!()
    await until(() => t.recovery.calls.length === 2)
    expect(t.state().active?.schedule).toBeUndefined()
    expect(t.state().recovery?.state).toBe("requested")
    scheduled[0]!()
    await t.setup.viewRepositorySetup("setup", "prompts", "chore")
    expect(t.state().view).toBe("prompts")
    expect(t.store.session().phase).toBe("idle")
    held.release()
    await until(() => t.state().recovery?.state !== "requested")
    expect(t.recovery.calls).toHaveLength(2)
    expect(scheduled).toHaveLength(outcome === "future" ? 2 : 1)
    expect(t.state().recovery?.registrationState).toBe(outcome === "failed" ? "unavailable" : "known")
    expect(t.calls).toEqual([])
  } finally { held.release(); await t.close(); timers.mockRestore(); clock.mockRestore() }
})

test.each(["pause", "account", "dispose"])("%s cancels and fences a pending chore time refresh", async stop => {
  let now = Date.UTC(2026, 8, 17, 9)
  const due = now + 60_000, clock = spyOn(Date, "now").mockImplementation(() => now)
  const originalTimeout = globalThis.setTimeout, scheduled: Array<() => void> = []
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 60_000) scheduled.push(() => callback(...args))
    return originalTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  const t = await fixture(async body => {
    const result = await response(body, "completed", "pause").json()
    return Response.json({ ...result, receipt: { ...result.receipt, registrationId: "scheduled" } })
  })
  try {
    const payload = { ...initialSetup("example/repo", "chores", "maintainer"), inspectedAt: 1 }
    payload.draft.schedule = "* * * * *"
    const policy = { revision: 1, digest: setupCandidate(payload), registrationId: "scheduled", sourceRevision: "source", enabled: true, owned: true, workspaceId, draft: payload.draft,
      schedule: { expression: payload.draft.schedule, nextFireAt: new Date(due).toISOString() } }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...t.store.collections.cards.get("setup")!, kind: "repository-setup", payload } }).isPersisted.promise
    t.recovery.answer = async () => Response.json({ owner: "maintainer", repo: payload.repo, job: "chores", registration: { state: "known", active: policy }, setup: { state: "none" } })
    t.setup.resumeRepositorySetups()
    await until(() => scheduled.length === 1)
    if (stop === "pause") {
      await t.setup.runRepositorySetup("setup", "pause")
      await until(() => t.state().active?.enabled === false)
    } else if (stop === "account") {
      t.ctx.accountEpoch++
      await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "other", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      t.setup.resumeRepositorySetups()
    } else await t.close()
    now = due; scheduled[0]!()
    await new Promise(resolve => originalTimeout(resolve, 10))
    expect(t.recovery.calls).toHaveLength(1)
    expect(t.calls).toHaveLength(stop === "pause" ? 1 : 0)
  } finally { await t.close(); timers.mockRestore(); clock.mockRestore() }
})

test.each(["completed", "failed"])("a due chore keeps a busy setup admission and refreshes once after it %s", async phase => {
  let now = Date.UTC(2026, 8, 17, 9)
  const due = now + 60_000, clock = spyOn(Date, "now").mockImplementation(() => now)
  const originalTimeout = globalThis.setTimeout, scheduled: Array<() => void> = []
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 60_000) scheduled.push(() => callback(...args))
    return originalTimeout(callback, delay, ...args)
  }) as typeof setTimeout)
  const held = deferred(), t = await fixture(async body => { await held.promise; return response(body, phase) })
  try {
    const payload = { ...initialSetup("example/repo", "chores", "maintainer"), inspectedAt: 1 }
    payload.draft.schedule = "* * * * *"
    const policy = { revision: 1, digest: setupCandidate(payload), registrationId: "scheduled", sourceRevision: "source", enabled: true, owned: true, workspaceId, draft: payload.draft }
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...t.store.collections.cards.get("setup")!, kind: "repository-setup", payload } }).isPersisted.promise
    t.recovery.answer = async () => Response.json({ owner: "maintainer", repo: payload.repo, job: "chores", registration: { state: "known", active: { ...policy,
      schedule: { expression: payload.draft.schedule, nextFireAt: new Date(t.recovery.calls.length === 1 ? due : due + 60_000).toISOString() }
    } }, setup: { state: "none" } })
    t.setup.resumeRepositorySetups()
    await until(() => scheduled.length === 1)
    await t.setup.runRepositorySetup("setup", "evaluate")
    const requestId = t.state().request!.id
    now = due; scheduled[0]!()
    await until(() => t.state().active?.schedule === undefined)
    expect(t.state().request?.id).toBe(requestId)
    expect(t.state().request?.state).toBe("requested")
    expect(t.state().request?.observeOnly).toBeUndefined()
    expect(t.recovery.calls).toHaveLength(1)
    held.release()
    await until(() => scheduled.length === 2)
    expect(t.recovery.calls).toHaveLength(2)
    expect(t.calls).toHaveLength(1)
    expect(t.state().evaluation?.phase).toBe(phase)
    expect(t.state().active?.schedule?.nextFireAt).toBe(new Date(due + 60_000).toISOString())
  } finally { held.release(); await t.close(); timers.mockRestore(); clock.mockRestore() }
})

test("the composed app wires setup guidance to its existing conversation agent", async () => {
  const { createAppController } = await import("../AppController")
  const requests: StartAgentTurnRequest[] = []
  const t = await fixture(async body => response(body))
  const controller = createAppController(t.store, unavailableRepositories, recordingAgent(requests), {
    fetchImpl: async () => Response.json({}, { status: 404 })
  })
  try {
    const result = await controller.commands.run("setup.guide", "setup")
    expect(result.status).toBe("executed")
    await until(() => requests.some(request => request.purpose !== "recommend"))
    const conversation = requests.find(request => request.purpose !== "recommend")!
    expect(JSON.stringify(conversation.messages)).toContain("Read setup.guide for card setup")
    expect(conversation.instructions).toContain("one short question at a time")
    expect(t.store.collections.cards.get("setup")?.kind).toBe("repository-setup")
  } finally { await controller.dispose(); await t.close() }
})

test("manual work drafts survive reload without changing the active candidate or evidence", async () => {
  const t = await fixture(async body => response(body))
  try {
    const digest = setupCandidate(t.state())
    await t.setup.prepareRepositoryWork("setup", "fix")
    await t.setup.prepareRepositoryWork("setup", "fix", "source", "smithers-cloud")
    await t.setup.prepareRepositoryWork("setup", "fix", "number", 42)
    await t.setup.prepareRepositoryWork("setup", "fix", "prompt", "Keep the compatibility contract.")
    expect(t.state().manualDraft).toEqual({ stepId: "fix", source: "smithers-cloud", number: 42, prompt: "Keep the compatibility contract." })
    expect(t.state().view).toBe("work")
    expect(setupCandidate(t.state())).toBe(digest)
    expect(t.calls).toHaveLength(0)
    const storage = t.storage
    const saved = t.state().manualDraft
    await t.close()
    const again = await fixture(async body => response(body), storage)
    try { expect(again.state().manualDraft).toEqual(saved) } finally { await again.close() }
  } finally { await t.close() }
})

test("manual execution requires a matched active policy and retries the exact work request", async () => {
  let lost = true
  const opened: string[] = []
  const t = await fixture(async body => {
    if (lost) throw Error("Connection lost")
    const result = await response(body, "completed", "run").json()
    result.receipt.jobRunId = "actual-job-run"
    return Response.json(result)
  }, memoryStorage(), doors({ openRun: async runId => { opened.push(runId) } }))
  const manual = { stepId: "fix", prompt: "Fix the underlying cause", subject: { source: "github", kind: "issue", number: 42 } } as const
  try {
    expect(await t.setup.runRepositorySetup("setup", "run", manual)).toBe("Enable this setup before running work.")
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...t.state(),
      active: { enabled: true, revision: 1, digest: setupCandidate(t.state()), registrationId: "registered", sourceRevision: "immutable-source" } } } as typeof card }).isPersisted.promise
    await t.setup.runRepositorySetup("setup", "run", manual)
    await Promise.all(t.background)
    const requestId = t.state().request!.id
    expect(t.state().request?.manual).toEqual(manual)
    lost = false
    await t.setup.retryRepositorySetup("setup")
    await Promise.all(t.background)
    expect(t.calls.map(call => [call.body.requestId, call.body.manual])).toEqual([[requestId, manual], [requestId, manual]])
    expect(t.state().request?.state).toBe("completed")
    expect(opened).toEqual(["run-1", "actual-job-run"])
    expect(cardContainsRun(t.store.collections.cards.get("setup")!, "actual-job-run")).toBe(true)
    await t.setup.configureRepositorySetup("setup", "step.fix.prompt", "Changed policy")
    expect(await t.setup.runRepositorySetup("setup", "run", manual)).toBe("Test and apply this draft before running work.")
    expect(t.calls).toHaveLength(2)
  } finally { await t.close() }
})

test("manual wrapper completion without a dispatched job stays a visible failure", async () => {
  const t = await fixture(async body => response(body, "completed", "run"))
  try {
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...t.state(),
      active: { enabled: true, revision: 1, digest: setupCandidate(t.state()), registrationId: "registered", sourceRevision: "immutable-source" } } } as typeof card }).isPersisted.promise
    await t.setup.runRepositorySetup("setup", "run", { stepId: "poc", prompt: "", subject: { source: "smithers-cloud", kind: "issue", number: 3 } })
    await Promise.all(t.background)
    expect(t.state().request?.state).toBe("failed")
    expect(t.state().request?.error).toBe("The host did not provide the completed job run.")
    expect([...t.store.collections.toasts.values()].some(toast => toast.status === "ok")).toBe(false)
  } finally { await t.close() }
})

test("immediate Run waits for ordered work edits and uses the latest durable form, not an older render", async () => {
  const t = await fixture(async body => {
    const result = await response(body, "completed", "run").json()
    result.receipt.jobRunId = "actual-job"
    return Response.json(result)
  })
  try {
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...t.state(),
      active: { enabled: true, revision: 1, digest: setupCandidate(t.state()), registrationId: "registered", sourceRevision: "immutable-source" } } } as typeof card }).isPersisted.promise
    const edits = [t.setup.prepareRepositoryWork("setup", "fix", "source", "smithers-cloud"),
      t.setup.prepareRepositoryWork("setup", "fix", "number", 42),
      t.setup.prepareRepositoryWork("setup", "fix", "prompt", "Preserve compatibility")]
    const requested = t.setup.runRepositorySetup("setup", "run")
    await Promise.all([...edits, requested])
    await Promise.all(t.background)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]!.body.manual).toEqual({ stepId: "fix", prompt: "Preserve compatibility", subject: { source: "smithers-cloud", kind: "issue", number: 42 } })
  } finally { await t.close() }
})

test("a bare manual Run opens the persisted work form instead of sending missing subject data", async () => {
  const t = await fixture(async body => response(body))
  try {
    const card = t.store.collections.cards.get("setup")!
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: { ...t.state(),
      active: { enabled: true, revision: 1, digest: setupCandidate(t.state()), registrationId: "registered", sourceRevision: "immutable-source" } } } as typeof card }).isPersisted.promise
    expect(await t.setup.runRepositorySetup("setup", "run")).toEqual({ value: "Work request is open." })
    expect(t.state().view).toBe("work")
    expect(t.state().manualDraft).toMatchObject({ stepId: "research", prompt: "" })
    expect(t.calls).toHaveLength(0)
  } finally { await t.close() }
})

const recoveredInspection = (repo = "example/repo"): SetupRecoveryResponse => {
  const setup = initialSetup(repo, "issues", "maintainer")
  const input = { requestId: "stored-inspection", operation: "inspect" as const, repo, job: setup.job, revision: 1, digest: setupCandidate(setup), draft: setup.draft }
  const receipt = { requestId: input.requestId, runId: "stored-run", revision: 1, digest: input.digest, operation: "inspect" as const,
    phase: "completed" as const, updatedAt: 10, results: [], evidence: ["source:abc"] }
  return { owner: "maintainer", repo, job: "issues", registration: { state: "known" }, setup: { state: "found", input,
    result: { requestId: input.requestId, revision: 1, digest: input.digest, workspaceId, receipt,
      inspection: { inspectedAt: 10, sources: [{ path: "README.md", status: "read", summary: "Actual source", revision: "abc" }],
        suggestedDraft: { ...setup.draft, cases: [{ id: "repo-case", name: "Repository case", input: "An example issue", expected: "A source-bound answer", required: true }] } } } } }
}
const setupCard = (t: Awaited<ReturnType<typeof fixture>>) => [...t.store.collections.cards.values()].find(card => card.kind === "repository-setup" && card.id !== "setup") as Extract<import("../AppState").Card, { kind: "repository-setup" }>

// This is the actual absent-card/controller/store seam. Fixtures answer the
// backend state contract explicitly; no local completion flags are seeded.
test("missing-card recovery acknowledges before an unresolved read, coalesces opens and restores completed cases without POST", async () => {
  const opened: string[] = []
  const t = await fixture(async () => { throw Error("Recovery must not POST") }, memoryStorage(), doors({ openRun: async id => { opened.push(id) } })), held = deferred()
  t.recovery.answer = async () => { await held.promise; return Response.json(recoveredInspection()) }
  try {
    const acknowledged = await Promise.race([t.setup.openRepositorySetup("issues", "example/repo"), new Promise(resolve => setTimeout(() => resolve("blocked"), 150))])
    expect(acknowledged).not.toBe("blocked")
    const card = setupCard(t)
    expect(card.payload.recovery?.state).toBe("requested")
    await t.setup.openRepositorySetup("issues", "example/repo")
    expect(t.recovery.calls).toHaveLength(1)
    await t.setup.viewRepositorySetup(card.id, "evals")
    expect(t.store.session().phase).toBe("idle")
    await until(() => [...t.store.collections.toasts.values()].some(toast => toast.status === "running"))
    held.release(); await Promise.all(t.background)
    const restored = setupCard(t).payload
    expect(restored.draft.cases.map(item => item.id)).toEqual(["repo-case"])
    expect(restored.revision).toBe(2)
    expect(restored.view).toBe("evals")
    expect(restored.request?.observeOnly).toBe(true)
    expect(restored.request?.state).toBe("completed")
    expect(restored.previousReceipts[0]?.phase).toBe("completed")
    expect(restored.workspaceId).toBe(workspaceId)
    expect(opened).toEqual([])
    expect(restored.evaluation).toBeUndefined()
    expect(restored.trial).toBeUndefined()
    expect(t.calls).toEqual([])
  } finally { held.release(); await t.close() }
})

test("pending recovery survives restart; late old-owner replies and edited drafts are fenced", async () => {
  const first = await fixture(async () => { throw Error("No launch") }), old = deferred()
  first.recovery.answer = async () => { await old.promise; return Response.json(recoveredInspection()) }
  await first.setup.openRepositorySetup("issues", "example/repo")
  const id = setupCard(first).id
  await first.close()
  const t = await fixture(async () => { throw Error("No launch") }, first.storage), held = deferred()
  t.recovery.answer = async () => { await held.promise; return Response.json(recoveredInspection()) }
  try {
    t.setup.resumeRepositorySetups()
    await until(() => t.recovery.calls.length === 1)
    await t.setup.configureRepositorySetup(id, "budgetMinutes", 17)
    old.release(); await Promise.all(first.background)
    held.release(); await Promise.all(t.background)
    expect(setupCard(t).payload.draft.budgetMinutes).toBe(17)
    expect(setupCard(t).payload.draft.cases).toEqual([])
    expect(setupCard(t).payload.request?.id).toBe("stored-inspection")
    expect(t.calls).toEqual([])
    const again = deferred()
    t.recovery.answer = async () => { await again.promise; return Response.json(recoveredInspection()) }
    await t.setup.openRepositorySetup("issues", "example/repo")
    t.ctx.accountEpoch += 1
    await t.store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "bob", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
    again.release(); await Promise.all(t.background)
    expect(setupCard(t)).toBeUndefined()
    expect([...t.store.collections.cards.values()].some(card => card.kind === "repository-setup")).toBe(false)
    expect(t.calls).toEqual([])
  } finally { old.release(); held.release(); await t.close() }
})

test("actual observed apply completion cannot replace newer paused policy or become a new POST after reload", async () => {
  const t = await fixture(async body => response(body, "completed", "apply"))
  const recovered = recoveredInspection(), base = initialSetup("example/repo", "issues", "maintainer")
  const digest = setupCandidate(base), newer = { ...base, revision: 3 }
  recovered.setup = { state: "found", input: { requestId: "old-apply", operation: "apply", repo: base.repo, job: base.job, draft: base.draft, revision: 1, digest }, result: {
    requestId: "old-apply", revision: 1, digest, workspaceId, receipt: { requestId: "old-apply", operation: "apply", revision: 1, digest, runId: "run-1", phase: "running", updatedAt: 2, results: [], evidence: ["run:run-1"] }
  } }
  recovered.registration = { state: "known", active: { registrationId: "registration-new", workspaceId, owned: true, enabled: false,
    revision: 3, digest: setupCandidate(newer), sourceRevision: "new-source", draft: base.draft } }
  t.recovery.answer = async () => Response.json(recovered)
  try {
    await t.setup.openRepositorySetup("issues", "example/repo")
    await until(() => setupCard(t).payload.request?.state === "completed")
    expect(setupCard(t).payload.active?.enabled).toBe(false)
    expect(setupCard(t).payload.active?.revision).toBe(3)
    expect(setupCard(t).payload.revision).toBe(4)
    expect(t.calls.map(call => call.method)).toEqual(["GET"])
    const id = setupCard(t).id
    await t.close()
    const again = await fixture(async body => response(body, "completed", "apply"), t.storage)
    try {
      await again.setup.retryRepositorySetup(id); await Promise.all(again.background)
      expect(again.calls.map(call => call.method)).toEqual(["GET"])
      expect(setupCard(again).payload.active?.enabled).toBe(false)
      expect(setupCard(again).payload.request?.observeOnly).toBe(true)
    } finally { await again.close() }
  } finally { await t.close() }
})

test("discovery archives a completed local pause before an older apply replaces it, including repeated reopen", async () => {
  const t = await fixture(async () => { throw Error("Discovery cannot run work") })
  const applied = { ...initialSetup("example/repo", "issues", "maintainer"), revision: 4 }
  const digest = setupCandidate(applied)
  const pause = { requestId: "local-pause", operation: "pause" as const, revision: 4, digest, runId: "pause-run", phase: "completed" as const, updatedAt: 20, results: [], evidence: ["paused:registration"] }
  const history = ["inspect", "evaluate", "trial"].map(operation => ({ ...pause, requestId: `earlier-${operation}`, operation: operation as "inspect" | "evaluate" | "trial", runId: `${operation}-run`, updatedAt: 10 }))
  const active = { registrationId: "paused-registration", workspaceId, owned: true, enabled: false, revision: 4, digest, sourceRevision: "immutable-source", draft: applied.draft }
  const recovered: SetupRecoveryResponse = { owner: "maintainer", repo: applied.repo, job: applied.job, registration: { state: "known", active }, setup: {
    state: "found", input: { requestId: "old-apply", operation: "apply", repo: applied.repo, job: applied.job, draft: applied.draft, revision: 4, digest },
    result: { requestId: "old-apply", revision: 4, digest, workspaceId, receipt: { ...pause, requestId: "old-apply", operation: "apply", runId: "apply-run", updatedAt: 15 } }
  } }
  const id = "setup:maintainer:example%2Frepo:issues"
  await t.store.dispatch({ type: "card.upsert", actor: "system", card: { id, kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: t.store.nextOrdinal(),
    payload: { ...applied, revision: 5, inspectedAt: 10, workspaceId, receipt: pause, previousReceipts: history, active,
      request: { id: pause.requestId, operation: "pause", revision: 4, digest, state: "completed" } }
  } }).isPersisted.promise
  t.recovery.answer = async () => Response.json(recovered)
  try {
    await t.setup.openRepositorySetup("issues", applied.repo); await Promise.all(t.background)
    const state = setupCard(t).payload
    expect(state.receipt?.requestId).toBe("old-apply")
    expect(state.previousReceipts).toEqual([...history, pause])
    expect(state.active?.enabled).toBe(false)
    expect(state.revision).toBe(5)
    expect(state.evaluation).toBeUndefined()
    expect(state.trial).toBeUndefined()
    expect(t.calls).toEqual([])
    await t.close()
    const reopened = await fixture(async () => { throw Error("Discovery cannot run work") }, t.storage)
    reopened.recovery.answer = async () => Response.json(recovered)
    try {
      await reopened.setup.openRepositorySetup("issues", applied.repo); await Promise.all(reopened.background)
      expect(setupCard(reopened).payload.previousReceipts).toEqual([...history, pause])
      expect(setupCard(reopened).payload.active?.enabled).toBe(false)
      expect(reopened.calls).toEqual([])
      expect((await reopened.store.verifyState()).valid).toBe(true)
    } finally { await reopened.close() }
  } finally { await t.close() }
})

test("partial recovery failure never launches a fresh inspection or infers missing eval and trial proof", async () => {
  const t = await fixture(async () => { throw Error("No launch") })
  const base = initialSetup("example/repo", "issues", "maintainer")
  const registration = { registrationId: "active-foreign", workspaceId, revision: 4, digest: setupCandidate({ ...base, revision: 4 }), sourceRevision: "source", enabled: true, owned: false, draft: base.draft }
  t.recovery.answer = async () => Response.json({ owner: "maintainer", repo: base.repo, job: base.job, registration: { state: "known", active: registration }, setup: { state: "unavailable", error: "Stored receipt is unavailable" } })
  try {
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.active?.enabled).toBe(true)
    expect(card.payload.active?.owned).toBe(false)
    expect(card.payload.workspaceId).toBeUndefined()
    expect(card.payload.recovery?.registrationState).toBe("known")
    expect(card.payload.evaluation).toBeUndefined()
    expect(card.payload.trial).toBeUndefined()
    expect(card.payload.recovery?.state).toBe("failed")
    expect(t.calls).toEqual([])
    t.recovery.answer = async () => Response.json({ owner: "maintainer", repo: base.repo, job: base.job, registration: { state: "unavailable", error: "HTTP 503" }, setup: { state: "none" } })
    await t.setup.retryRepositorySetup(card.id); await Promise.all(t.background)
    expect(setupCard(t).payload.recovery?.registrationState).toBe("unavailable")
    expect(setupCard(t).payload.active?.enabled).toBe(true)
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})

test("expired unknown execution has a finite failure toast and its Retry only observes", async () => {
  const t = await fixture(async (_body, method) => { expect(method).toBe("GET"); return Response.json({ message: "No recorded run" }, { status: 503 }) })
  const recovered = recoveredInspection()
  if (recovered.setup.state !== "found") throw Error("fixture")
  const input = { ...recovered.setup.input, operation: "apply" as const }
  recovered.setup = { state: "found", input, observationError: "Expired", result: { requestId: input.requestId, revision: input.revision, digest: input.digest,
    receipt: { requestId: input.requestId, revision: input.revision, digest: input.digest, operation: "apply", phase: "queued", updatedAt: 1, results: [], evidence: [] } } }
  t.recovery.answer = async () => Response.json(recovered)
  try {
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.request?.state).toBe("failed")
    expect(card.payload.request?.error).toContain("unknown")
    expect(t.calls).toEqual([])
    expect([...t.store.collections.toasts.values()].every(toast => toast.status !== "running")).toBe(true)
    await t.setup.retryRepositorySetup(card.id); await Promise.all(t.background)
    expect(t.calls.map(call => call.method)).toEqual(["GET"])
    expect(setupCard(t).payload.receipt?.phase).toBe("queued")
  } finally { await t.close() }
})

test("known-run observation error gets one bounded read; another failure settles and Retry remains read-only", async () => {
  let failing = true
  const t = await fixture(async body => {
    if (failing) return Response.json({}, { status: 503 })
    const result = await response(body, "completed", "evaluate").json() as { receipt: { runId: string } }
    result.receipt.runId = "stored-run"
    return Response.json(result)
  })
  const recovered = recoveredInspection()
  if (recovered.setup.state !== "found") throw Error("fixture")
  recovered.setup = { ...recovered.setup, observationError: "Observation expired", input: { ...recovered.setup.input, operation: "evaluate" },
    result: { ...recovered.setup.result, inspection: undefined, receipt: { ...recovered.setup.result.receipt!, operation: "evaluate", phase: "waiting" } } }
  t.recovery.answer = async () => Response.json(recovered)
  try {
    await t.setup.openRepositorySetup("issues", "example/repo")
    await until(() => setupCard(t).payload.request?.state === "failed")
    const id = setupCard(t).id
    expect(t.calls.map(call => call.method)).toEqual(["GET"])
    expect(setupCard(t).payload.receipt?.phase).toBe("waiting")
    expect([...t.store.collections.toasts.values()].every(toast => toast.status !== "running")).toBe(true)
    failing = false
    await t.setup.retryRepositorySetup(id); await Promise.all(t.background)
    expect(t.calls.map(call => call.method)).toEqual(["GET", "GET"])
    expect(setupCard(t).payload.request?.state).toBe("completed")
  } finally { await t.close() }
})

test("recovery rejects mismatched candidate and workspace identities while retaining current input", () => {
  const initial = initialSetup("example/repo", "issues", "maintainer")
  const current = { ...initial, recovery: { id: "recover", baseRevision: 1, baseDigest: setupCandidate(initial), adoptDraft: true, state: "requested" as const, registrationState: "unknown" as const } }
  const badDigest = recoveredInspection()
  if (badDigest.setup.state !== "found") throw Error("fixture")
  badDigest.setup.input.draft.budgetMinutes += 1
  expect(() => projectRecoveredSetup(current, badDigest)).toThrow("does not match")
  const wrongWorkspace = recoveredInspection()
  if (wrongWorkspace.setup.state !== "found") throw Error("fixture")
  wrongWorkspace.setup.input.workspaceId = "22222222-2222-4222-8222-222222222222"
  expect(() => projectRecoveredSetup(current, wrongWorkspace)).toThrow("does not match")
  expect(current.revision).toBe(1)
})

test("edits survive a failed discovery followed by successful Retry and later refresh", async () => {
  const t = await fixture(async () => { throw Error("No launch") }), held = deferred()
  t.recovery.answer = async () => { await held.promise; return Response.json({ owner: "maintainer", repo: "example/repo", job: "issues", registration: { state: "unavailable", error: "Offline" }, setup: { state: "none" } }) }
  try {
    await t.setup.openRepositorySetup("issues", "example/repo")
    const id = setupCard(t).id
    await t.setup.configureRepositorySetup(id, "budgetMinutes", 19)
    held.release(); await Promise.all(t.background)
    t.recovery.answer = async () => Response.json(recoveredInspection())
    await t.setup.retryRepositorySetup(id); await Promise.all(t.background)
    expect(setupCard(t).payload.draft.budgetMinutes).toBe(19)
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    expect(setupCard(t).payload.draft.budgetMinutes).toBe(19)
    expect(t.calls).toEqual([])
  } finally { held.release(); await t.close() }
})

test("held recovery admission persists before network and duplicates cannot cross a failed sign-out epoch", async () => {
  const t = await fixture(async () => { throw Error("No launch") }), held = deferred()
  const dispatch = t.store.dispatch.bind(t.store)
  let persisting = false
  const spy = spyOn(t.store, "dispatch").mockImplementation(transition => {
    const result = dispatch(transition)
    if (transition.type !== "card.upsert" || transition.card.kind !== "repository-setup" || transition.card.payload.recovery?.state !== "requested") return result
    persisting = true
    const persisted = { ...result.isPersisted, promise: held.promise.then(() => result.isPersisted.promise) }
    return new Proxy(result, { get: (target, key, receiver) => key === "isPersisted" ? persisted : Reflect.get(target, key, receiver) })
  })
  try {
    const first = t.setup.openRepositorySetup("issues", "example/repo")
    await until(() => persisting)
    const duplicate = t.setup.openRepositorySetup("issues", "example/repo")
    expect(t.recovery.calls).toEqual([])
    // The identity row remains after refused local sign-out cleanup, but the
    // account epoch already invalidates both waiting admissions.
    t.ctx.accountEpoch += 1
    held.release(); await Promise.all([first, duplicate])
    expect(t.recovery.calls).toEqual([])
    expect(t.calls).toEqual([])
  } finally { held.release(); spy.mockRestore(); await t.close() }
})

test.each(["registration", "setup"] as const)("a held %s partial-response body cannot cross owner epochs or release the next observer", async failed => {
  const t = await fixture(async () => { throw Error("No launch") }), old = deferred(), next = deferred()
  let count = 0, reading = false
  const value: SetupRecoveryResponse = failed === "registration" ? { ...recoveredInspection(), registration: { state: "unavailable", error: "Policy offline" } }
    : { owner: "maintainer", repo: "example/repo", job: "issues", registration: { state: "known" }, setup: { state: "unavailable", error: "Receipt offline" } }
  t.recovery.answer = async () => {
    count += 1
    if (count > 1) { await next.promise; return Response.json(recoveredInspection()) }
    const response = Response.json(value)
    response.json = async () => { reading = true; await old.promise; return value }
    return response
  }
  try {
    await t.setup.openRepositorySetup("issues", "example/repo")
    await until(() => reading)
    t.ctx.accountEpoch += 1
    await t.setup.openRepositorySetup("issues", "example/repo")
    expect(count).toBe(2)
    old.release(); await t.background[0]
    expect(setupCard(t).payload.recovery?.state).toBe("requested")
    await t.setup.openRepositorySetup("issues", "example/repo")
    expect(count).toBe(2)
    next.release(); await Promise.all(t.background)
    expect(setupCard(t).payload.request?.state).toBe("completed")
    expect(setupCard(t).payload.recovery?.state).toBe("completed")
    expect(setupCard(t).payload.draft.cases[0]?.id).toBe("repo-case")
    expect(t.calls).toEqual([])
  } finally { old.release(); next.release(); await t.close() }
})

test("a late discovery remains bound to its explicit repository when global selection changes", async () => {
  const t = await fixture(async () => { throw Error("No launch") }), held = deferred()
  t.recovery.answer = async () => { await held.promise; return Response.json(recoveredInspection()) }
  try {
    await t.setup.openRepositorySetup("issues", "example/repo")
    await t.store.dispatch({ type: "repo.selected", actor: "user", id: "other/repository" }).isPersisted.promise
    held.release(); await Promise.all(t.background)
    expect(setupCard(t).payload.repo).toBe("example/repo")
    expect(setupCard(t).payload.request?.state).toBe("completed")
    expect(t.recovery.calls.every(url => new URL(url, "https://app.test").searchParams.get("repo") === "example/repo")).toBe(true)
    expect(t.calls).toEqual([])
  } finally { held.release(); await t.close() }
})

test("a changed server session cannot adopt another account's recovery before the local identity row refreshes", async () => {
  const t = await fixture(async () => { throw Error("No launch") })
  t.recovery.answer = async () => Response.json({ ...recoveredInspection(), owner: "bob" })
  try {
    await t.setup.openRepositorySetup("issues", "example/repo"); await Promise.all(t.background)
    const card = setupCard(t)
    expect(card.payload.owner).toBe("maintainer")
    expect(card.payload.recovery?.error).toContain("different account")
    expect(card.payload.workspaceId).toBeUndefined()
    expect(card.payload.request).toBeUndefined()
    expect(card.payload.draft.cases).toEqual([])
    expect(card.payload.active).toBeUndefined()
    expect(t.calls).toEqual([])
  } finally { await t.close() }
})
