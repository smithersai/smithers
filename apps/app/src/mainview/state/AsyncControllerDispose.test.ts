import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { createControllerContext } from "./controller/context"
import { createGuideController } from "./controller/guide"
import type { AppStore } from "./AppStore"

const createAppController = scopedControllers()

const repositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "unused" })
}
const agent: AgentPort = {
  available: true,
  startTurn: async () => ({ status: "error", message: "unused" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}
const store = () => {
  const bytes = new Map<string, string>()
  return createAppStore({
    kind: "localStorage",
    storage: {
      getItem: (key) => bytes.get(key) ?? null,
      setItem: (key, value) => {
        bytes.set(key, value)
      },
      removeItem: (key) => {
        bytes.delete(key)
      }
    }
  })
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("controller shutdown has an awaitable completion boundary", () => {
  test("immediate shutdown joins automatic startup without late writes or model/tool starts", async () => {
    const actual = await store()
    let shuttingDown = false
    const lateWrites: string[] = []
    let starts = 0
    const observed: AppStore = {
      ...actual,
      dispatch: transition => {
        if (shuttingDown) lateWrites.push(transition.type)
        return actual.dispatch(transition)
      }
    }
    const controller = createAppController(observed, repositories, {
      ...agent,
      startTurn: async () => { starts++; return { status: "error", message: "unexpected model start" } }
    }, {
      fetchImpl: async () => { starts++; throw new Error("unexpected network/tool start") }
    })
    const before = actual.session().revision
    shuttingDown = true
    await controller.dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(lateWrites).toEqual([])
    expect(starts).toBe(0)
    expect(actual.session().revision).toBe(before)
    expect([...actual.collections.repositoryContexts.values()]).toEqual([])
    await expect(controller.commands.run("onboarding.act", "start")).resolves.toEqual({ status: "failed", error: "The controller is closed." })
    expect(lateWrites).toEqual([])
  })

  test("shutdown waits for a pending startup receipt and prevents its repository follow-up", async () => {
    const actual = await store()
    const entered = deferred()
    const receipt = deferred()
    let shuttingDown = false
    let hostClosed = false
    const lateWrites: string[] = []
    const observed: AppStore = {
      ...actual,
      dispatch: transition => {
        if (shuttingDown) lateWrites.push(transition.type)
        const transaction = actual.dispatch(transition)
        if (transition.type !== "guide.changed") return transaction
        entered.resolve()
        return new Proxy(transaction, {
          get: (target, property, receiver) => property === "isPersisted"
            ? { ...target.isPersisted, promise: target.isPersisted.promise.then(() => receipt.promise) }
            : Reflect.get(target, property, receiver)
        })
      },
      dispose: async () => { await actual.dispose?.(); hostClosed = true }
    }
    const controller = createAppController(observed, repositories, agent)
    await entered.promise
    shuttingDown = true
    const closing = controller.dispose()
    try {
      await Promise.resolve()
      expect(hostClosed).toBe(false)
      expect(lateWrites).toEqual([])
    } finally {
      receipt.resolve()
      await closing
    }
    expect(hostClosed).toBe(true)
    expect(lateWrites).toEqual([])
    expect([...actual.collections.repositoryContexts.values()]).toEqual([])
  })

  test("a guide whose queued action resumes after disposal cannot dispatch or call its next effect", async () => {
    const actual = await store()
    const context = createControllerContext(actual, repositories, agent, {})
    context.onDispose(() => actual.dispose?.())
    const before = actual.session().revision
    let followups = 0
    const guide = createGuideController(context, async () => { followups++ })
    const pending = guide.guideAct("start")
    const closing = context.dispose()
    expect(context.disposed).toBe(true)
    await Promise.all([pending, closing])
    expect(actual.session().revision).toBe(before)
    expect(followups).toBe(0)
  })

  test("asynchronous failures and pump-stop failures are collected without skipping other resources", async () => {
    const context = createControllerContext(await store(), repositories, agent, {})
    const releaseError = new Error("resource failed")
    const pumpError = new Error("pump failed")
    const released: string[] = []
    context.stopWorkflowPumps = () => {
      released.push("pumps")
      throw pumpError
    }
    context.onDispose(() => {
      released.push("host")
    })
    context.onDispose(async () => {
      released.push("dependent")
      throw releaseError
    })
    const first = context.dispose()
    expect(context.dispose()).toBe(first)
    let caught: unknown
    try {
      await first
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([pumpError, releaseError])
    expect(released).toEqual(["pumps", "dependent", "host"])
    await expect(context.dispose()).rejects.toBe(caught)
    expect(released).toHaveLength(3)
  })

  test("a direct reentrant self-wait is refused without hanging or skipping host cleanup", async () => {
    const context = createControllerContext(await store(), repositories, agent, {})
    let released = 0
    context.onDispose(() => {
      released += 1
    })
    context.onDispose(() => context.dispose())
    await expect(context.dispose()).rejects.toThrow(AggregateError)
    expect(released).toBe(1)
  })

  test("an asynchronous finalizer added after disposal is returned to its acquiring caller", async () => {
    const context = createControllerContext(await store(), repositories, agent, {})
    await context.dispose()
    const failure = new Error("late resource failed")
    await expect(context.onDispose(async () => {
      throw failure
    })).rejects.toBe(failure)
  })

  test("a host stays alive until its dependent asynchronous resource releases", async () => {
    const context = createControllerContext(await store(), repositories, agent, {})
    const held = deferred()
    const released: string[] = []
    context.onDispose(() => {
      released.push("host")
    })
    context.onDispose(async () => {
      released.push("dependent-start")
      await held.promise
      released.push("dependent-end")
    })
    const closing = Promise.resolve(context.dispose())
    let complete = false
    void closing.then(() => {
      complete = true
    })
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(complete).toBe(false)
      expect(released).toEqual(["dependent-start"])
    } finally {
      held.resolve()
      await closing
    }
    expect(released).toEqual(["dependent-start", "dependent-end", "host"])
  })

  test("the public controller waits for persistence close after synchronously detaching the agent", async () => {
    const held = deferred()
    let listeners = 0
    let closed = false
    const controller = createAppController(
      {
        ...await store(),
        dispose: async () => {
          await held.promise
          closed = true
        }
      },
      repositories,
      {
        ...agent,
        subscribe: () => {
          listeners += 1
          return () => {
            listeners -= 1
          }
        }
      }
    )
    const closing = Promise.resolve(controller.dispose())
    let complete = false
    void closing.then(() => {
      complete = true
    })
    try {
      expect(listeners).toBe(0)
      await Promise.resolve()
      await Promise.resolve()
      expect(complete).toBe(false)
    } finally {
      held.resolve()
      await closing
    }
    expect(closed).toBe(true)
  })
})
