/*
 * Launch Checklist D-4 — the zero-balance UX. AppState.ts:290-296's ruling
 * says chat is complimentary (a $0 balance never pauses it — Backends.test.ts
 * already pins that) and the pause discipline applies only to
 * non-complimentary (paid) work: workflow launches. These tests pin the other
 * half — `flow.create`/`flow.run` at a definitive $0 balance render a clear,
 * embedded transcript message and never reach the workspace/gateway seam at
 * all (no hang, no stack trace, deterministic).
 */
import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "./AppController"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const silentAgent = (): AgentPort => ({
  available: true,
  startTurn: async () => ({ status: "started" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

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
    const controller = createAppController(store, unavailableRepositories, silentAgent(), noWorkflowSeam())
    await signInAtZeroBalance(store)

    const outcome = await controller.commands.run("flow.run", "review-pr")

    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(EXHAUSTED_TEXT)
  })

  test("flow.create at $0 fails deterministically with the exhausted-balance message, no seam call", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), noWorkflowSeam())
    await signInAtZeroBalance(store)

    const outcome = await controller.commands.run("flow.create", "summarize my open issues")

    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe(EXHAUSTED_TEXT)
  })

  test("the exhausted-balance message renders embedded in the transcript (THE EMBED LAW), not a toast-only surface", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), noWorkflowSeam())
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
      ...silentAgent(),
      startTurn: async () => {
        turns += 1
        return { status: "started" }
      }
    }
    const controller = createAppController(store, unavailableRepositories, countingAgent, noWorkflowSeam())
    await signInAtZeroBalance(store)

    controller.send("what's the status of my repo?")
    await settle()

    expect(turns).toBe(1)
    expect(transcriptTexts(store)).not.toContain(EXHAUSTED_TEXT)
  })

  test("a positive balance never triggers the exhausted-balance guard", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), noWorkflowSeam())
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
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).not.toBe(EXHAUSTED_TEXT)
  })

  test("an unread/unavailable billing seam never blocks a workflow launch (gate on answers, not silence)", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), noWorkflowSeam())
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

    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).not.toBe(EXHAUSTED_TEXT)
  })

  test("a button-driven flow.run at $0 does not double-surface the refusal as a toast", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, silentAgent(), noWorkflowSeam())
    await signInAtZeroBalance(store)

    controller.runCommand("flow.run", "review-pr")
    await settle()

    expect(transcriptTexts(store)).toContain(EXHAUSTED_TEXT)
    const toasts = [...store.collections.toasts.values()]
    expect(toasts.some((toast) => toast.detail === EXHAUSTED_TEXT)).toBe(false)
  })
})
