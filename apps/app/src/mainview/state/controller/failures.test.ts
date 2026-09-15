import type { StorageApi } from "@tanstack/db"
import { afterEach, describe, expect, test } from "bun:test"
import { initialGuide } from "../AppState"
import { createAppStore } from "../AppStore"
import type { ControllerContext } from "./context"
import { createFailureController, humanCommandText } from "./failures"

/*
 * The toast run counter used to be write-only: every withToast set an entry
 * and nothing ever removed one, so the map grew for the session's lifetime.
 * Settling deletes the entry equality-guarded — a newer run of the same key
 * keeps its own slot untouched — and the ok toast's later self-dismissal is
 * guarded by the toast's own state, never by the counter.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const disposeContexts = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const dispose of disposeContexts) await dispose()
  disposeContexts.clear()
})

const fakeContext = async (options?: {
  readonly toastDebounceMs?: number
  readonly toastAutoDismissMs?: number
}): Promise<{ ctx: ControllerContext; store: Awaited<ReturnType<typeof createAppStore>> }> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let disposed = false
  const cleanups: Array<() => void> = []
  const ctx = {
    store,
    get disposed() { return disposed },
    onDispose: (cleanup: () => void) => { cleanups.push(cleanup) },
    toastRuns: new Map<string, number>(),
    toastDebounceMs: options?.toastDebounceMs ?? 0,
    toastAutoDismissMs: options?.toastAutoDismissMs ?? 0,
    commands: { find: (name: string) => {
      const summary = ({ "auth.sign-in": "Sign in with GitHub", "prs.list": "Read pull requests", "wiki.create": "Create Wiki" } as Record<string, string>)[name]
      return summary ? { metadata: { summary } } : undefined
    } },
    unref: () => {}
  } as unknown as ControllerContext
  disposeContexts.add(async () => {
    disposed = true
    for (const cleanup of cleanups) cleanup()
    await store.dispose?.()
  })
  return { ctx, store }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

test("human command references leave diagnostic URLs and file paths intact", async () => {
  const { ctx } = await fakeContext()
  expect(humanCommandText(ctx.commands, "Try /auth.sign-in. See https://host/auth.sign-in and /api/auth.sign-in for details."))
    .toBe("Try Sign in with GitHub. See https://host/auth.sign-in and /api/auth.sign-in for details.")
})

describe("the toast run counter's terminal cleanup", () => {
  test("an ok run's entry leaves at settle; the toast then dismisses itself on its own state", async () => {
    const { ctx, store } = await fakeContext()
    const failures = createFailureController(ctx)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = failures.withToast("flow.ok", "Working…", "Done", () => gate.then(() => true))
    await settled()
    release()
    await pending
    // Settling is the slot's terminal act: the entry is gone at once. The
    // ok toast's self-dismissal is guarded by the toast's own state
    // (resolveToast), not by the counter, so nothing stale can misfire.
    expect(ctx.toastRuns.has("flow.ok")).toBe(false)
    expect(store.collections.toasts.get("toast-flow.ok")?.status).toBe("ok")
    await settled()
    expect(store.collections.toasts.get("toast-flow.ok")).toBeUndefined()
  })

  test("a failed run's entry leaves at settle even though its toast stays", async () => {
    const { ctx, store } = await fakeContext()
    const failures = createFailureController(ctx)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = failures.withToast("flow.bad", "Working…", "Done", () => gate.then(() => "it broke"))
    await settled()
    release()
    const outcome = await pending
    expect(outcome).toBe("it broke")
    expect(ctx.toastRuns.has("flow.bad")).toBe(false)
    // The failure toast itself still waits for the user.
    expect(store.collections.toasts.get("toast-flow.bad")?.status).toBe("failed")
  })

  test("work settled before the debounce leaves no entry behind", async () => {
    const { ctx, store } = await fakeContext({ toastDebounceMs: 10_000 })
    const failures = createFailureController(ctx)
    await failures.withToast("flow.quick", "Working…", "Done", async () => true)
    expect(store.collections.toasts.size).toBe(0)
    expect(ctx.toastRuns.has("flow.quick")).toBe(false)
  })

  test("a superseding run keeps its own slot when the stale run settles", async () => {
    const { ctx } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    let releaseStale!: () => void
    let releaseCurrent!: () => void
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve
    })
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    const stale = failures.withToast("flow.race", "Working…", "Done", () => staleGate.then(() => "stale line"))
    const current = failures.withToast("flow.race", "Working…", "Done", () => currentGate.then(() => true))
    await settled()
    releaseStale()
    await stale
    // The current run owns the slot; the stale run settled without touching it.
    expect(ctx.toastRuns.get("flow.race")).toBe(2)
    releaseCurrent()
    await current
    // The current run's settle is the slot's terminal act.
    expect(ctx.toastRuns.has("flow.race")).toBe(false)
  })
})

/*
 * Ownership of a toast slot is an allocation question, not a counting one:
 * the number a run holds must never be handed back out while that run is
 * still in flight. Deriving it from the map made the newest run's terminal
 * delete recycle it — three overlapping runs was enough to hand run 1's
 * number to run 3.
 */
describe("toast slot ownership across three overlapping runs", () => {
  test("a stale run that settles last cannot resolve the newest run's toast", async () => {
    const { ctx, store } = await fakeContext({ toastAutoDismissMs: 10_000 })
    const failures = createFailureController(ctx)
    const gate = () => {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      return { promise, release }
    }
    const first = gate()
    const second = gate()
    const third = gate()
    // A is still running when B settles; C starts afterwards and owns the slot.
    const a = failures.withToast("flow.overlap", "Working…", "Done", () => first.promise.then(() => "old A failed"))
    const b = failures.withToast("flow.overlap", "Working…", "Done", () => second.promise.then(() => true))
    await settled()
    second.release()
    await b
    const c = failures.withToast("flow.overlap", "Working…", "Done", () => third.promise.then(() => true))
    await settled()
    expect(store.collections.toasts.get("toast-flow.overlap")?.status).toBe("running")

    first.release()
    await a
    // A is two runs stale: C's running notice names work still in flight.
    expect(store.collections.toasts.get("toast-flow.overlap")?.status).toBe("running")
    expect(ctx.toastRuns.has("flow.overlap")).toBe(true)

    third.release()
    await c
    const done = store.collections.toasts.get("toast-flow.overlap")
    expect(done?.status).toBe("ok")
    expect(done?.title).toBe("Done")
  })
})

test("a refused command's notice dismisses itself after stating the refusal", async () => {
  const { ctx, store } = await fakeContext()
  const failures = createFailureController(ctx)
  failures.surfaceCommandFailure("prs.list", { status: "failed", error: "The read was refused." })
  expect(store.collections.toasts.get("toast-command.failed.prs.list")?.detail).toBe("The read was refused.")
  expect(store.collections.toasts.get("toast-command.failed.prs.list")?.title).toBe("Read pull requests didn't run")
  await settled()
  expect(store.collections.toasts.get("toast-command.failed.prs.list")).toBeUndefined()
})

test("a seam's sign-in notice uses human summaries and dismisses even with an action", async () => {
  const { ctx, store } = await fakeContext()
  createFailureController(ctx).surfaceCommandFailure("prs.list", { status: "failed", error: "Use /auth.sign-in to continue." })
  const toast = store.collections.toasts.get("toast-command.failed.prs.list")
  expect(toast?.title).toBe("Read pull requests didn't run")
  expect(toast?.detail).toBe("Use Sign in with GitHub to continue.")
  expect(toast?.action).toEqual({ flow: "auth.sign-in", label: "Sign in with GitHub" })
  await settled()
  expect(store.collections.toasts.size).toBe(0)
})


test("a background setup failure already shown inline does not emit a duplicate command alert", async () => {
  const { ctx, store } = await fakeContext()
  const failures = createFailureController(ctx)
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 12,
    librarianLaunches: [{ kind: "wiki", repo: "will/demo", scope: JSON.stringify(["will/demo", null, null, null, null, 0]), startedAt: 1, phase: "failed", reason: "setup failed" }],
  } }).isPersisted.promise
  failures.surfaceCommandFailure("wiki.create", { status: "failed", error: "setup failed" })
  expect(store.collections.toasts.size).toBe(0)
  failures.surfaceCommandFailure("wiki.create", { status: "failed", error: "different failure" })
  expect(store.collections.toasts.get("toast-command.failed.wiki.create")?.detail).toBe("different failure")
})

test("a background failure after the lesson leaves its Retry toast as the only alert", async () => {
  const { ctx, store } = await fakeContext()
  await store.dispatch({ type: "guide.changed", actor: "system", guide: { ...initialGuide(), step: 13,
    librarianLaunches: [{ kind: "history", repo: "will/demo", scope: JSON.stringify(["will/demo", null, null, null, null, 0]),
      startedAt: 1, phase: "failed", runId: "history-run", reason: "Error: Error: git exited 1" }] }
  }).isPersisted.promise
  createFailureController(ctx).surfaceCommandFailure("history.bootstrap", { status: "failed", error: "Error: Error: git exited 1" })
  expect(store.collections.toasts.size).toBe(0)
})



for (const name of ["onboarding.act", "tut", "tut.more"]) test(`${name} keeps a guide refusal under the lesson without a flow-name toast`, async () => {
  const { ctx, store } = await fakeContext()
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 14 } }).isPersisted.promise
  createFailureController(ctx).surfaceCommandFailure(name, { status: "failed", error: "The repository catalog could not be read." })
  expect([...store.collections.toasts.values()]).toEqual([])
  expect(store.session().guide?.notice).toBe("The repository catalog could not be read.")
  await store.dispose?.()
})


test("a typed practice refusal already shown in its run card has no second command-failure toast", async () => {
  const { ctx, store } = await fakeContext()
  const reason = "This practice run did not start because agent runs are temporarily limited."
  await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "live-tutorial-research", kind: "run-trace", title: "Research", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "practice:smithersai/hello-server", runId: "pending", workflow: "issue.research", phase: "stopped", steps: [], result: null, lastSeq: 0, observationError: reason,
      input: { liveTutorial: { playthrough: 0 }, liveTutorialLimit: { kind: "rate-limit" } } } } }).isPersisted.promise
  createFailureController(ctx).surfaceCommandFailure("issue.repro", { status: "failed", error: reason })
  expect([...store.collections.toasts.values()]).toEqual([])
  await store.dispose?.()
})
