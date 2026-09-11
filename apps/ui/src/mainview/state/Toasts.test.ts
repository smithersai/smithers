import { describe, expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage, settled, silentAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The 300ms toast law (2026-08-09): background work not settled within 300ms
 * states what is running on the shared corner stack; work under 300ms never
 * flashes anything; a settled toast resolves into the result; a failure toast
 * is honest and stays until dismissed.
 */

const balanceJson = new Response(
  JSON.stringify({
    user: "will",
    balance: { totalUsd: "500", totalNanos: 0, lifetimeChargedUsd: "0", chargeCount: 0 },
    state: "ok",
    allowedToStartWork: true,
    credits: []
  }),
  { status: 200, headers: { "content-type": "application/json" } }
)

describe("the 300ms toast law", () => {
  test("work settled under 300ms never flashes a toast", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: async () => balanceJson.clone(),
      toastDebounceMs: 300
    })
    await controller.refreshBalance()
    await settled()
    expect(store.collections.toasts.size).toBe(0)
  })

  test("work not settled within 300ms states what is running, then resolves", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
      toastDebounceMs: 0
    })
    const pending = controller.refreshBalance()
    await settled()
    const running = store.collections.toasts.get("toast-billing.balance.refresh")
    expect(running?.status).toBe("running")
    expect(running?.title).toBe("Refreshing your balance…")

    release(balanceJson.clone())
    await pending
    const resolvedToast = store.collections.toasts.get("toast-billing.balance.refresh")
    expect(resolvedToast?.status).toBe("ok")
    expect(store.collections.billingAccounts.get("billing")?.totalUsd).toBe("500")
  })

  test("a failure resolves the toast honestly and it stays until dismissed", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
      toastDebounceMs: 0
    })
    const pending = controller.refreshBalance()
    await settled()
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("running")

    release(new Response(JSON.stringify({ status: "error" }), { status: 503 }))
    await pending
    const failed = store.collections.toasts.get("toast-billing.balance.refresh")
    expect(failed?.status).toBe("failed")
    expect(failed?.detail).toBe("Your balance couldn't be refreshed right now.")

    // It never auto-dismisses: the user clears it through the command.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.collections.toasts.get("toast-billing.balance.refresh")).toBeDefined()
    expect(controller.commands.find("toast.dismiss")).toBeDefined()
    controller.runCommand("toast.dismiss", "toast-billing.balance.refresh")
    await settled()
    expect(store.collections.toasts.get("toast-billing.balance.refresh")).toBeUndefined()
  })

  test("a settled toast states its result, never the running sentence", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
      toastDebounceMs: 0,
      toastAutoDismissMs: 10_000
    })
    const pending = controller.refreshBalance()
    await settled()
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.title).toBe(
      "Refreshing your balance…"
    )
    release(balanceJson.clone())
    await pending
    const done = store.collections.toasts.get("toast-billing.balance.refresh")
    expect(done?.status).toBe("ok")
    // The done toast lingers for a few seconds — it must not still read as running.
    expect(done?.title).toBe("Balance is up to date")
  })

  test("a re-run's running toast outlives the previous run's auto-dismiss", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
      toastDebounceMs: 0,
      toastAutoDismissMs: 20
    })
    const first = controller.refreshBalance()
    await settled()
    release(balanceJson.clone())
    await first
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("ok")

    // A second run claims the slot before the first run's dismissal fires.
    const second = controller.refreshBalance()
    await settled()
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("running")
    await new Promise((resolve) => setTimeout(resolve, 40))
    // The stale timer must not have swallowed the notice for work still in flight.
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("running")
    release(balanceJson.clone())
    await second
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("ok")
  })

  test("a flow that fails resolves honestly instead of leaving a toast running", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
      toastDebounceMs: 0
    })
    const pending = controller.refreshBalance()
    await settled()
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("running")
    // An answer that isn't a Response at all: the flow reports its own honest
    // failure, and the toast still settles instead of hanging on "running".
    release({ ok: false } as unknown as Response)
    await pending
    await settled()
    const toast = store.collections.toasts.get("toast-billing.balance.refresh")
    expect(toast?.status).toBe("failed")
    expect(toast?.detail).toContain("couldn't be refreshed")
  })

  test("toasts are notifications, not state: they never survive a restart", async () => {
    const storage = memoryStorage()
    const first = await createAppStore({ kind: "localStorage", storage })
    first.dispatch({ type: "toast.shown", actor: "system", key: "repos.first-run", title: "Reading your repositories…" })
    expect(first.collections.toasts.size).toBe(1)
    // isPersisted settles before a fresh store can preload the row.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.collections.toasts.size).toBe(0)
    const journal = [...reopened.collections.transitions.values()]
    expect(journal.some((record) => record.type === "toast.dismissed" && record.actor === "system")).toBe(true)
  })
})
