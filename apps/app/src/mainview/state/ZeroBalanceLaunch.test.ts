/*
 * Launch Checklist D-4 — the zero-balance UX. AppState.ts:290-296's ruling
 * says chat is complimentary (a $0 balance never pauses it — Backends.test.ts
 * already pins that) and the pause discipline applies only to
 * non-complimentary (paid) work: managed workflow launches. Explicit cloud
 * workspace runs use their own provider; the gateway enforces their access
 * and capacity. These tests pin the other
 * half — `flow.create`/`flow.run` at a definitive $0 balance render a clear,
 * embedded transcript message and never reach the workspace/gateway seam at
 * all (no hang, no stack trace, deterministic).
 */
import { describe, expect, test } from "bun:test"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { memoryStorage, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const settle = async (ticks = 4): Promise<void> => {
  for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

const REPO = "codeplanesmithers/smithers-demo"

const EXHAUSTED_TEXT =
  "Balance is at $0: flow runs pause until more balance is added. Run /billing.upgrade to add balance; chat stays free in the meantime."

/** A backend that answers nothing about workflows — proves the guard never calls it. */
const noWorkflowSeam = (): AppServices => ({
  fetchImpl: async () => new Response(JSON.stringify({ status: "error", message: "unreachable" }), { status: 500 })
})

const signInAtZeroBalance = async (
  store: Awaited<ReturnType<typeof webStore>>,
  loaded: ReadonlyArray<string> = [REPO]
): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [...loaded].map((fullName) => ({
      id: fullName,
      org: fullName.split("/")[0] ?? "",
      ownerKind: "user",
      name: fullName.split("/")[1] ?? "",
      head: null
    }))
  })
  store.dispatch({
    type: "billing.refreshed",
    actor: "system",
    state: "empty",
    totalUsd: "0",
    allowedToStartWork: false,
    lifetimeChargedUsd: "500",
    chargeCount: 12
  })
  await settle(2)
}

const transcriptTexts = (store: Awaited<ReturnType<typeof webStore>>): ReadonlyArray<string> =>
  [...store.collections.messages.values()]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((message) => message.text)

describe("zero-balance workflow launch (Launch Checklist D-4)", () => {
  test("flow.run at $0 fails deterministically with the exhausted-balance message, no seam call", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, noWorkflowSeam())
    await signInAtZeroBalance(store)

    const outcome = await controller.commands.run("flow.run", "review-pr")

    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(EXHAUSTED_TEXT)
  })

  test("flow.create at $0 fails deterministically with the exhausted-balance message, no seam call", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, noWorkflowSeam())
    await signInAtZeroBalance(store)

    const outcome = await controller.commands.run("flow.create", "summarize my open issues")

    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(EXHAUSTED_TEXT)
  })

  test("the exhausted-balance message renders embedded in the transcript (THE EMBED LAW), not a toast-only surface", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, noWorkflowSeam())
    await signInAtZeroBalance(store)

    await controller.commands.run("flow.run", "review-pr")

    const texts = transcriptTexts(store)
    expect(texts).toContain(EXHAUSTED_TEXT)
    const message = [...store.collections.messages.values()].find((entry) => entry.text === EXHAUSTED_TEXT)
    expect(message?.role).toBe("smithers")
  })

  test("a $0 balance never blocks interactive chat — only workflow launch pauses", async () => {
    const store = await webStore()
    let turns = 0
    const countingAgent: AgentPort = {
      ...silentAgent,
      startTurn: async () => {
        turns += 1
        return { status: "started" }
      }
    }
    const controller = createAppController(store, countingAgent, noWorkflowSeam())
    await signInAtZeroBalance(store)

    controller.send("what's the status of my repo?")
    await settle()

    expect(turns).toBe(1)
    expect(transcriptTexts(store)).not.toContain(EXHAUSTED_TEXT)
  })

  test("a positive balance never triggers the exhausted-balance guard", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, noWorkflowSeam())
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [REPO].map((fullName) => ({
        id: fullName,
        org: fullName.split("/")[0] ?? "",
        ownerKind: "user",
        name: fullName.split("/")[1] ?? "",
        head: null
      }))
    })
    store.dispatch({
      type: "billing.refreshed",
      actor: "system",
      state: "ok",
      totalUsd: "500",
      allowedToStartWork: true,
      lifetimeChargedUsd: "0",
      chargeCount: 0
    })
    await settle(2)

    const outcome = await controller.commands.run("flow.run", "review-pr")

    // The guard is not in the way any more — the (unreachable, stubbed 500)
    // workspace seam is what fails next, never the balance message.
    expect(outcome.status).toBe("executed")
    await waitFor(() => [...store.collections.cards.values()].some(card => card.kind === "run-trace" && card.status === "error"))
    expect(transcriptTexts(store)).not.toContain(EXHAUSTED_TEXT)
  })

  test("an unread/unavailable billing seam never blocks a workflow launch (gate on answers, not silence)", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, noWorkflowSeam())
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-in",
      login: "will",
      allowlisted: true,
      admin: false,
      scopesPlain: null
    })
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [REPO].map((fullName) => ({
        id: fullName,
        org: fullName.split("/")[0] ?? "",
        ownerKind: "user",
        name: fullName.split("/")[1] ?? "",
        head: null
      }))
    })
    await settle(2)
    // `seed()` (AppStore.ts) always inserts `initialBillingAccount()` before
    // `createAppStore` resolves, so the row is never actually absent by the
    // time a command can run — the unread seam shows up as state "unknown"
    // with `allowedToStartWork` defaulted true, not as a missing row.
    const billing = store.collections.billingAccounts.get("billing")
    expect(billing?.state).toBe("unknown")
    expect(billing?.allowedToStartWork).toBe(true)

    const outcome = await controller.commands.run("flow.run", "review-pr")

    expect(outcome.status).toBe("executed")
    await waitFor(() => [...store.collections.cards.values()].some(card => card.kind === "run-trace" && card.status === "error"))
    expect(transcriptTexts(store)).not.toContain(EXHAUSTED_TEXT)
  })

  test("a button-driven flow.run at $0 does not double-surface the refusal as a toast", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, noWorkflowSeam())
    await signInAtZeroBalance(store)

    controller.runCommand("flow.run", "review-pr")
    await settle()

    expect(transcriptTexts(store)).toContain(EXHAUSTED_TEXT)
    const toasts = [...store.collections.toasts.values()]
    expect(toasts.some((toast) => toast.detail === EXHAUSTED_TEXT)).toBe(false)
  })
})


test("a selected cloud workspace uses its own provider at zero managed balance", async () => {
  const store = await webStore()
  const calls: string[] = []
  const controller = createAppController(store, silentAgent, {
    fetchImpl: async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ status: "error", message: "workspace probe" }), { status: 500 })
    }
  })
  await signInAtZeroBalance(store)
  const workspaceId = "11111111-1111-4111-8111-111111111111"
  await store.dispatch({ type: "workspaces.loaded", actor: "system", workspaces: [{
    id: workspaceId, repoId: REPO, name: "Coding", targetBookmark: "main", status: "running",
    provisioningStage: null, suspendedAt: null, createdAt: null
  }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: REPO + "#workspace:" + workspaceId }).isPersisted.promise
  calls.length = 0
  const outcome = await controller.commands.run("flow.run", "coding/request " + REPO + ' {"prompt":"Document cloud development"}')
  expect(outcome.status).toBe("executed")
  await waitFor(() => [...store.collections.cards.values()].some(card => card.kind === "run-trace" && card.status === "error"))
  expect(calls.some(url => url.includes("workflow/provision"))).toBe(true)
  expect(transcriptTexts(store)).not.toContain(EXHAUSTED_TEXT)
  // Selecting a cloud copy must not exempt another repository's managed run.
  const other = await controller.commands.run("flow.run", "review-pr someone/else")
  expect(other.status).toBe("failed")
  if (other.status === "failed") expect(other.error).toBe(EXHAUSTED_TEXT)
})
