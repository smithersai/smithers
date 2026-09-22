import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppStore } from "../AppStore"
import { createAuthBillingController } from "./auth-billing"
import { createControllerContext } from "./context"
import { createFailureController } from "./failures"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const repositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "native unavailable"
  })
}

const agent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", code: "native-required", message: "native unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const signedIn = {
  state: "signed-in" as const,
  login: "will",
  allowlisted: true,
  admin: false
}

const runSignedInEntry = async (entry: "load" | "adopt", sessionAnswer: Record<string, unknown> = signedIn) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const calls: string[] = []
  const ctx = createControllerContext(store, repositories, agent, {
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const body = new URL(url, "https://app.test").pathname.endsWith("/auth/session")
        ? sessionAnswer
        : {
          state: "ok",
          allowedToStartWork: true,
          balance: { totalUsd: "500", lifetimeChargedUsd: "0", chargeCount: 0 }
        }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  })
  ctx.identityChanged = () => calls.push("identityChanged")
  ctx.resumeWorkflowRuns = () => calls.push("resumeWorkflowRuns")
  ctx.resumeDeferredCommand = () => calls.push("resumeDeferredCommand")
  ctx.withToast = async <T>(
    key: string,
    _title: string,
    _doneTitle: string,
    work: () => Promise<T | string>
  ): Promise<T | string> => {
    if (key === "billing.balance.refresh") calls.push("refreshBalance")
    return work()
  }

  const controller = createAuthBillingController(ctx, () => 0)
  if (entry === "load") await controller.loadSession()
  else await controller.adoptSession(signedIn)
  await new Promise((resolve) => setTimeout(resolve, 0))

  return {
    calls,
    transitions: [...store.collections.transitions.values()].map(({ actor, type, payload }) => ({
      actor,
      type,
      payload: JSON.parse(payload) as unknown
    }))
  }
}

describe("signed-in session adoption", () => {
  test("an authority-admitted public session resumes the app without inheriting admin", async () => {
    const publicSession = await runSignedInEntry("load", { login: "new-user", allowlisted: false, admission: "public", admin: true })
    expect(publicSession.transitions[0]?.payload).toMatchObject({ login: "new-user", allowlisted: true, admin: false })
    expect(publicSession.calls).toContain("resumeWorkflowRuns")
  })
  test("live and server-resolved sessions share every transition and follow-on call", async () => {
    const live = await runSignedInEntry("load")
    const adopted = await runSignedInEntry("adopt")

    expect(adopted.transitions).toEqual(live.transitions)
    expect(live.transitions).toEqual([
      {
        actor: "system",
        type: "identity.session.loaded",
        payload: { ...signedIn, scopesPlain: null }
      },
      {
        actor: "system",
        type: "billing.refreshed",
        payload: {
          state: "ok",
          totalUsd: "500",
          allowedToStartWork: true,
          lifetimeChargedUsd: "0",
          chargeCount: 0
        }
      }
    ])
    expect(adopted.calls).toEqual(live.calls)
    expect(live.calls).toEqual([
      "identityChanged",
      "refreshBalance",
      "resumeWorkflowRuns",
      "resumeDeferredCommand"
    ])
  })
})

/*
 * The sign-in return path. From a repository page (`/owner/name`) the
 * sign-in door names that page as `return_to`; from the landing page it
 * names nothing. Coming back, `?signed-in=github` on either page counts as
 * handled (so the boot strips it) without a chat message: the session probe
 * already says who signed in.
 */
describe("sign-in return path", () => {
  interface WindowStub {
    location: { pathname: string; search: string; assign: (url: string) => void }
  }
  const withWindow = async (pathname: string, search: string, run: (assigned: string[]) => Promise<void>) => {
    const assigned: string[] = []
    const stub: WindowStub = { location: { pathname, search, assign: (url) => void assigned.push(url) } }
    const globals = globalThis as unknown as { window?: unknown }
    const had = "window" in globals
    const previous = globals.window
    globals.window = stub
    try {
      await run(assigned)
    } finally {
      if (had) globals.window = previous
      else delete globals.window
    }
  }

  const signedOutController = async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const ctx = createControllerContext(store, repositories, agent, {
      fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    })
    store.dispatch({
      type: "identity.session.loaded",
      actor: "system",
      state: "signed-out",
      login: null,
      allowlisted: false,
      admin: false,
      scopesPlain: null
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { store, controller: createAuthBillingController(ctx, () => 0) }
  }

  test("from a repository page the sign-in door names that page as return_to", async () => {
    const { controller } = await signedOutController()
    await withWindow("/smithersai/smithers", "?tab=issues", async (assigned) => {
      controller.signIn()
      // The redirect waits for the durable queue first (DurableCollection.settled), so it lands a tick later.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(assigned).toEqual(["/api/auth/github/start?return_to=%2Fsmithersai%2Fsmithers%3Ftab%3Dissues"])
    })
  })

  test("from the landing page the sign-in door carries no return path", async () => {
    const { controller } = await signedOutController()
    await withWindow("/", "?repo=smithersai/smithers", async (assigned) => {
      controller.signIn()
      // The redirect waits for the durable queue first (DurableCollection.settled), so it lands a tick later.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(assigned).toEqual(["/api/auth/github/start"])
    })
  })

  test("the signed-in marker is handled silently; a failed return still speaks", async () => {
    const { store, controller } = await signedOutController()
    const messages = () => [...store.collections.messages.values()].length
    const before = messages()
    expect(controller.handleAuthReturn("?signed-in=github")).toBe(true)
    expect(messages()).toBe(before)
    expect(controller.handleAuthReturn("?tab=issues")).toBe(false)
    expect(controller.handleAuthReturn("?auth=failed")).toBe(true)
    expect(messages()).toBe(before + 1)
  })
})

describe("native sign-in handoff ownership", () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const json = (body: unknown) => Response.json(body)
  const setup = async (pause: "start" | "wait" | "claim" | "session" | "reopen" | "start-body" | "claim-body" | "session-body") => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const reached = deferred<void>()
    const response = deferred<Response>()
    const reopened = deferred<boolean>()
    const opened: string[] = []
    const requests: string[] = []
    let requestSignal: AbortSignal | null | undefined
    const ctx = createControllerContext(store, repositories, agent, {
      baseUrl: "https://app.test",
      handoffPollMs: pause === "wait" || pause === "reopen" ? 30 : 1,
      openExternal: async (url) => {
        opened.push(url)
        if (pause === "wait") reached.resolve()
        if (pause === "reopen" && opened.length === 2) {
          reached.resolve()
          return reopened.promise
        }
        return true
      },
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname
        requests.push(path)
        const stage = pause.replace("-body", "")
        if (path.endsWith(`/auth/native/${stage}`) || (stage === "session" && path.endsWith("/auth/session"))) {
          requestSignal = init?.signal
          // Deliberately ignore abort: late answers still need continuation fences.
          // boundedFetch buffers the body at the seam, so a stalled body is a
          // stream that withholds its chunk, not a slow `json()` on the Response.
          if (pause.endsWith("-body")) {
            return new Response(
              new ReadableStream<Uint8Array>({
                async pull(stream) {
                  reached.resolve()
                  const late = await response.promise
                  try {
                    stream.enqueue(new TextEncoder().encode(await late.text()))
                    stream.close()
                  } catch {
                    // The seam cancelled the reader first; the late answer is fenced.
                  }
                }
              }),
              { headers: { "content-type": "application/json" } }
            )
          }
          reached.resolve()
          return response.promise
        }
        if (path.endsWith("/start")) return json({ handoffId: "handoff-1", pollSecret: "secret-1" })
        if (path.endsWith("/claim")) return json({ status: pause.startsWith("session") ? "ready" : "failed" })
        return json(signedIn)
      }
    })
    ctx.withToast = async (_key, _title, _doneTitle, work) => work()
    ctx.resolveToast = (key, outcome) => {
      store.dispatch({ type: "toast.resolved", actor: "system", key, ...outcome })
    }
    store.dispatch({ type: "identity.session.loaded", actor: "system", ...signedIn,
      state: "signed-out", login: null, scopesPlain: null })
    const controller = createAuthBillingController(ctx, () => 0)
    const transitions = () => [...store.collections.transitions.values()]
    return { ctx, controller, store, reached, response, reopened, opened, requests, transitions,
      signal: () => requestSignal }
  }

  test("a second click before start answers prepares sign-in without opening an empty URL", async () => {
    const h = await setup("start")
    try {
      h.controller.signIn()
      await h.reached.promise
      h.controller.signIn()
      await tick()
      expect(h.opened).toEqual([])
      expect(h.requests).toEqual(["/api/auth/native/start"])
      const notice = h.store.collections.toasts.get("toast-auth.sign-in.handoff.reopened")
      expect(notice?.title).toBe("Preparing sign-in…")
      expect(notice?.detail).toBe("Sign-in is being prepared — your browser will open when it's ready.")
      expect(notice?.status).toBe("ok")
    } finally {
      await h.ctx.dispose()
      h.response.resolve(json({ handoffId: "handoff-1", pollSecret: "secret-1" }))
      await tick()
    }
  })

  test("disposal during the wait prevents any later claim or dispatch", async () => {
    const h = await setup("wait")
    h.controller.signIn()
    await h.reached.promise
    await tick()
    await h.ctx.dispose()
    const before = h.transitions()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.requests).toEqual(["/api/auth/native/start"])
    expect(h.transitions()).toEqual(before)
  })

  for (const pause of ["start", "claim", "session", "start-body", "claim-body", "session-body"] as const) {
    test(`disposal aborts the ${pause} request and fences its late answer`, async () => {
      const h = await setup(pause)
      h.controller.signIn()
      await h.reached.promise
      // Captured before disposal: an answer that lands *during* dispose is as
      // much a fenced late answer as one that lands after it.
      const before = h.transitions()
      const requestsBefore = [...h.requests]
      await h.ctx.dispose()
      h.response.resolve(json(pause.startsWith("start")
        ? { handoffId: "handoff-1", pollSecret: "secret-1" }
        : pause.startsWith("claim") ? { status: "ready" } : signedIn))
      await tick()
      await tick()
      expect(h.signal()?.aborted).toBe(true)
      expect(h.requests).toEqual(requestsBefore)
      expect(h.transitions()).toEqual(before)
      if (pause.startsWith("start")) expect(h.opened).toEqual([])
    })
  }

  test("a reopen finishing after disposal cannot dispatch its notice", async () => {
    const h = await setup("reopen")
    h.controller.signIn()
    while (h.opened.length === 0) await tick()
    h.controller.signIn()
    await h.reached.promise
    await h.ctx.dispose()
    const before = h.transitions()
    h.reopened.resolve(true)
    await tick()
    expect(h.transitions()).toEqual(before)
  })
})

/*
 * A refresh whose account moved out from under it writes nothing: the reply
 * describes an account the app no longer has open. Reporting "Balance is up
 * to date" for a balance nobody wrote is the silent-lie shape — the toast
 * must leave without claiming a result.
 */
describe("a balance refresh the account outlives", () => {
  test("an epoch change mid-request leaves no 'up to date' toast and no balance", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const ctx = createControllerContext(store, repositories, agent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
      toastDebounceMs: 0,
      toastAutoDismissMs: 10_000
    })
    ctx.withToast = createFailureController(ctx).withToast
    const controller = createAuthBillingController(ctx, () => 0)

    const pending = controller.refreshBalance()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.collections.toasts.get("toast-billing.balance.refresh")?.status).toBe("running")

    // A focus re-read adopted a different session while the request was out.
    ctx.accountEpoch += 1
    release(
      new Response(
        JSON.stringify({
          state: "ok",
          allowedToStartWork: true,
          balance: { totalUsd: "500", lifetimeChargedUsd: "0", chargeCount: 0 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    )
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.collections.billingAccounts.get("billing")?.state).not.toBe("ok")
    expect(store.collections.toasts.get("toast-billing.balance.refresh")).toBeUndefined()
  })
})

for (const entry of ["load", "adopt"] as const) {
  test(`${entry} waits for the web Cloud session before resuming a parked act`, async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const ctx = createControllerContext(store, repositories, agent, {
      fetchImpl: async () => Response.json(signedIn)
    })
    ctx.withToast = async (_key, _title, _done, work) => work()
    const calls: string[] = []
    let release!: () => void
    const cloud = new Promise<void>(resolve => { release = resolve })
    ctx.resumeDeferredCommand = () => calls.push("resume")
    const controller = createAuthBillingController(ctx, () => 0, async () => {
      calls.push("cloud")
      await cloud
    })
    const loading = entry === "load" ? controller.loadSession() : controller.adoptSession(signedIn)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual(["cloud"])
    release()
    await loading
    expect(calls).toEqual(["cloud", "resume"])
  })
}

/*
 * A balance read nobody asked for says nothing at all: the reads a session
 * load and a settled turn fire leave the toast stack empty while they run and
 * once they land, and signed out they do not run. A real failure still states
 * what failed and a later read clears it, a superseded one still writes
 * nothing, and the read a user asks for keeps its own notice and its own
 * result even when an automatic read answers first.
 */
describe("automatic balance refreshes", () => {
  const TOAST_ID = "toast-billing.balance.refresh"
  const balanceOk = {
    state: "ok",
    allowedToStartWork: true,
    balance: { totalUsd: "500", lifetimeChargedUsd: "0", chargeCount: 0 }
  }
  const setupBilling = async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const pending: Array<(response: Response) => void> = []
    const ctx = createControllerContext(store, repositories, agent, {
      fetchImpl: (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        return new URL(url, "https://app.test").pathname.endsWith("/auth/session")
          ? Promise.resolve(Response.json(signedIn))
          : new Promise<Response>((resolve) => {
            pending.push(resolve)
          })
      },
      toastDebounceMs: 0,
      toastAutoDismissMs: 10_000
    })
    ctx.withToast = createFailureController(ctx).withToast
    const toast = () => store.collections.toasts.get(TOAST_ID)
    const until = async (ready: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !ready(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(ready()).toBe(true)
    }
    return {
      ctx,
      controller: createAuthBillingController(ctx, () => 0),
      toast,
      balance: () => store.collections.billingAccounts.get("billing"),
      // Every request this harness holds open is a balance read; the session
      // probe answers from the branch above and never reaches the array.
      reads: () => pending.length,
      // The read is held open until the test answers it, so "while it runs" is
      // an observable window and not a race with the answer.
      inFlight: (count = 1) => until(() => pending.length >= count),
      answer: (index: number, response: Response) => pending[index]?.(response),
      release: (response: Response) => pending[pending.length - 1]?.(response),
      signedOut: () =>
        store.dispatch({
          type: "identity.session.loaded",
          actor: "system",
          state: "signed-out",
          login: null,
          allowlisted: false,
          admin: false,
          scopesPlain: null
        }).isPersisted.promise,
      running: () => until(() => toast()?.status === "running"),
      until
    }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  // Past the 300ms law's debounce: whatever the toast stack holds now is what
  // the read chose to say, not what it had not got round to saying yet.
  const pastDebounce = async () => {
    await tick()
    await tick()
  }
  // Long enough for a read that was going to be issued to have reached the
  // seam, so "no request" is a decision and not a measurement taken too early.
  const settle = async () => {
    for (let turn = 0; turn < 20; turn += 1) await tick()
  }

  test("a session load's refresh writes the balance and leaves no notice", async () => {
    const h = await setupBilling()
    void h.controller.loadSession()
    await h.inFlight()
    await pastDebounce()
    expect(h.toast()).toBeUndefined()
    h.release(Response.json(balanceOk))
    await h.until(() => h.balance()?.state === "ok")
    await tick()
    expect(h.balance()?.totalUsd).toBe("500")
    expect(h.toast()).toBeUndefined()
  })

  test("a settled turn's refresh writes the balance and leaves no notice", async () => {
    const h = await setupBilling()
    h.controller.settleTurnBilling()
    await h.inFlight()
    await pastDebounce()
    expect(h.toast()).toBeUndefined()
    h.release(Response.json(balanceOk))
    await h.until(() => h.balance()?.state === "ok")
    await tick()
    expect(h.balance()?.totalUsd).toBe("500")
    expect(h.toast()).toBeUndefined()
  })

  /*
   * Anonymous turns are a supported door on a public catalog repository, and
   * the server refuses a balance read for a session it never validated
   * (sign_in_required, 401). That refusal is the expected answer, not news:
   * the visitor has no balance and asked for nothing, so the read never goes
   * out. "unavailable" is left reading — a native deployment authenticates
   * the seam with its own bearer and has no session at all.
   */
  test("a settled turn while signed out reads nothing and says nothing", async () => {
    const h = await setupBilling()
    await h.signedOut()
    h.controller.settleTurnBilling()
    await settle()
    expect(h.reads()).toBe(0)
    expect(h.toast()).toBeUndefined()
  })

  test("a failed automatic refresh states the failure and nothing before it", async () => {
    const h = await setupBilling()
    h.controller.settleTurnBilling()
    await h.inFlight()
    await pastDebounce()
    expect(h.toast()).toBeUndefined()
    h.release(new Response("", { status: 500 }))
    await h.until(() => h.toast()?.status === "failed")
    expect(h.toast()).toMatchObject({
      title: "Refreshing your balance…",
      status: "failed",
      detail: "Your balance couldn't be refreshed right now."
    })
    expect(h.balance()?.state).not.toBe("ok")
  })

  /*
   * A failure nothing can clear is a permanent toast: the next automatic read
   * succeeds, the balance is fresh, and the sentence on screen is now false.
   * The read that heals it is still quiet on the way — it paints no notice
   * over the failure it is about to take down.
   */
  test("a later automatic refresh clears the failure an earlier one left", async () => {
    const h = await setupBilling()
    h.controller.settleTurnBilling()
    await h.inFlight()
    await pastDebounce()
    h.answer(0, new Response("", { status: 500 }))
    await h.until(() => h.toast()?.status === "failed")
    h.controller.settleTurnBilling()
    await h.inFlight(2)
    await pastDebounce()
    expect(h.toast()?.status).toBe("failed")
    h.answer(1, Response.json(balanceOk))
    await h.until(() => h.balance()?.state === "ok")
    await pastDebounce()
    expect(h.toast()).toBeUndefined()
  })

  test("an automatic refresh the account outlives writes no balance", async () => {
    const h = await setupBilling()
    h.controller.settleTurnBilling()
    await h.inFlight()
    await pastDebounce()
    h.ctx.accountEpoch += 1
    h.release(Response.json(balanceOk))
    await pastDebounce()
    expect(h.balance()?.state).not.toBe("ok")
    expect(h.toast()).toBeUndefined()
  })

  test("the balance a user asks for still states its result", async () => {
    const h = await setupBilling()
    const asked = h.controller.showBalance()
    await h.running()
    h.release(Response.json(balanceOk))
    expect(await asked).toEqual({ value: "balance: $500 left; $0 spent across 0 turn(s)" })
    expect(h.toast()).toMatchObject({ title: "Balance is up to date", status: "ok" })
  })

  test("an automatic refresh answering first leaves the asked-for read its notice", async () => {
    const h = await setupBilling()
    const asked = h.controller.showBalance()
    await h.running()
    h.controller.settleTurnBilling()
    await h.inFlight(2)
    h.answer(1, Response.json(balanceOk))
    await h.until(() => h.balance()?.state === "ok")
    await pastDebounce()
    expect(h.toast()).toMatchObject({ title: "Refreshing your balance…", status: "running" })
    h.answer(0, Response.json(balanceOk))
    expect(await asked).toEqual({ value: "balance: $500 left; $0 spent across 0 turn(s)" })
    expect(h.toast()).toMatchObject({ title: "Balance is up to date", status: "ok" })
  })
})
