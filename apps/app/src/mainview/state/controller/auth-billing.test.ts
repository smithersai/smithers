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

const runSignedInEntry = async (entry: "load" | "adopt") => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const calls: string[] = []
  const ctx = createControllerContext(store, repositories, agent, {
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const body = new URL(url, "https://app.test").pathname.endsWith("/auth/session")
        ? signedIn
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
      expect(assigned).toEqual(["/api/auth/github/start?return_to=%2Fsmithersai%2Fsmithers%3Ftab%3Dissues"])
    })
  })

  test("from the landing page the sign-in door carries no return path", async () => {
    const { controller } = await signedOutController()
    await withWindow("/", "?repo=smithersai/smithers", async (assigned) => {
      controller.signIn()
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
