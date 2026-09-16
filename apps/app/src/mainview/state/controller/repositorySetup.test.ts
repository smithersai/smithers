import { expect, test } from "bun:test"
import { initialSetup, setupCandidate, type RepositorySetup, type SetupManualRequest, type SetupDraft } from "@smthrs/rpc/RepositorySetup"
import { createAppStore } from "../AppStore"
import { memoryStorage, recordingAgent, unavailableRepositories } from "../TestFixtures"
import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { ControllerContext } from "./context"
import { createFailureController } from "./failures"
import { createRepositorySetupController, type RepositorySetupDependencies } from "./repositorySetup"
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
  const disposers: Array<() => void> = []
  const background: Promise<unknown>[] = []
  let previous: Body
  const ctx = { store, commandActor: "user", baseUrl: "", workflowPollMs: 5, toastRuns: new Map(),
    toastDebounceMs: 5, toastAutoDismissMs: 10000, disposed: false, unref: () => {},
    onDispose: (close: () => void) => { disposers.push(close) },
    errorMessageOf: async () => "The host refused the request.",
    boundedFetch: async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) as Body : previous!
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
  return { store, storage, calls, background, setup, state, close, ctx }
}

const doors = (overrides: Partial<RepositorySetupDependencies> = {}): RepositorySetupDependencies => ({
  promptSignIn: () => {}, chooseRepository: async () => {}, openRun: async () => {}, send: () => {}, ...overrides
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
    second.setup.resumeRepositorySetups(); await Promise.all(second.background)
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
  }, memoryStorage(), doors({ send: text => { messages.push(text) } }))
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

test("the agent guidance door reads current prompts and evidence without launching a nested turn", async () => {
  const messages: string[] = []
  const t = await fixture(async body => response(body), memoryStorage(), doors({ send: text => { messages.push(text) } }))
  try {
    const guide = createRepositorySetupController({ ...t.ctx, commandActor: "smithers" }, doors({ send: text => { messages.push(text) } }))
    await t.setup.configureRepositorySetup("setup", "step.research.prompt", "Read the repository's request handlers first.")
    const result = await guide.guideRepositorySetup("setup")
    expect(typeof result === "object" && result.value).toContain("Read the repository's request handlers first.")
    expect(typeof result === "object" && result.value).toContain("one short repository-informed question")
    expect(messages).toEqual([])
    expect(t.calls).toEqual([])
  } finally { await t.close() }
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
      await again.setup.openRepositorySetup("ci", "example/repo")
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
