import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../../native/NativeBridge"
import type { AgentPort } from "../../runtime/AgentPort"
import { createAppController } from "../AppController"
import type { AppServices } from "../AppController"
import { createAppStore } from "../AppStore"
import type { AppStore } from "../AppStore"

/*
 * The notifications seam, driven through the command registry: /notifications.list
 * surfaces the inbox as ONE "notifications" card (unread count + rows, off-shape
 * wire rows dropped, missing fields null), /notifications.read PUTs mark-read and
 * re-fetches so the card states the platform's answer. Failures answer the honest
 * string — never a throw, never a silent card.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

interface RecordedRequest {
  readonly path: string
  readonly method: string
}

/** Routes by pathname; everything unstubbed answers 404 (the dead-backend stance). */
const backend = (
  routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>,
  recorded: RecordedRequest[] = []
): AppServices => ({
  fetchImpl: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const absolute = new URL(url, "https://app.test")
    const path = absolute.pathname + absolute.search
    recorded.push({ path, method: init?.method ?? "GET" })
    for (const [route, answer] of Object.entries(routes)) {
      if (absolute.pathname === route) {
        return typeof answer === "function"
          ? answer(new Request(absolute.toString(), init))
          : answer.clone()
      }
    }
    return json(404, { status: "error", message: `no stub for ${path}` })
  }
})

const freshController = async (services: AppServices) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return {
    store,
    controller: createAppController(store, unavailableRepositories, unavailableAgent, services)
  }
}

const signedIn = async (store: AppStore): Promise<void> => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: false,
    scopesPlain: null
  })
  await settled()
}

/*
 * The wire inbox, GitHub-shaped like the platform's answer: a full row, a read
 * row, a bare row (everything optional missing), a subject-less row (dropped),
 * and a non-object (dropped).
 */
const wireInbox = [
  {
    id: 101,
    unread: true,
    reason: "review_requested",
    subject: { title: "Land the seam stack", url: "https://smithers-cloud.test/x", type: "Landing" },
    repository: { full_name: "will/flows" },
    updated_at: "2026-08-12T09:00:00Z",
    last_read_at: null
  },
  {
    id: "102",
    unread: false,
    reason: "mention",
    subject: { title: "Wave 13 notes", url: "", type: "Issue" },
    repository: { full_name: "will/mvp" },
    updated_at: "2026-08-11T18:30:00Z",
    last_read_at: "2026-08-11T19:00:00Z"
  },
  { id: 103, subject: { title: "Bare minimum row" } },
  { id: 104 },
  "garbage"
]

const readInbox = wireInbox.slice(0, 3).map((row) => (typeof row === "object" ? { ...row, unread: false } : row))

const notificationsCard = (store: AppStore) => {
  const card = store.collections.cards.get("notifications")
  if (card === undefined || card.kind !== "notifications") return undefined
  return card
}

describe("notifications.list", () => {
  test("surfaces the inbox as one card: unread count, parsed rows, missing fields null, off-shape rows dropped", async () => {
    const recorded: RecordedRequest[] = []
    const { store, controller } = await freshController(
      backend({ "/api/notifications/list": json(200, wireInbox) }, recorded)
    )
    await signedIn(store)

    const outcome = await controller.commands.run("notifications.list")
    expect(outcome.status).toBe("executed")
    await settled()

    const card = notificationsCard(store)
    expect(card).toBeDefined()
    expect(card?.title).toBe("Notifications")
    expect(card?.status).toBe("active")
    expect(card?.payload.unread).toBe(2)
    expect(card?.payload.items).toEqual([
      {
        id: "101",
        title: "Land the seam stack",
        repo: "will/flows",
        reason: "review_requested",
        createdAt: "2026-08-12T09:00:00Z",
        read: false
      },
      {
        id: "102",
        title: "Wave 13 notes",
        repo: "will/mvp",
        reason: "mention",
        createdAt: "2026-08-11T18:30:00Z",
        read: true
      },
      { id: "103", title: "Bare minimum row", repo: null, reason: null, createdAt: null, read: false }
    ])

    // The reference's query params ride along: a bounded page including read rows.
    const listCalls = recorded.filter((request) => request.path.startsWith("/api/notifications/list"))
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]?.method).toBe("GET")
    expect(listCalls[0]?.path).toContain("limit=20")
    expect(listCalls[0]?.path).toContain("all=true")
  })

  /*
   * §19.1: the platform this app talks to is NOT GitHub. It sends `subject`
   * as a plain string, no repository object, and `status: "unread" | "read"`.
   * Reading only the GitHub shape dropped every real row, so "Nothing new."
   * was the only state the card could ever reach.
   */
  test("the platform's own wire shape parses: string subject, status, created_at", async () => {
    const { store, controller } = await freshController(
      backend({
        "/api/notifications/list": json(200, [
          {
            id: 1,
            source_type: "issue",
            source_id: 1179,
            subject: "canary fixture: issue canary ui needs you",
            body: "…",
            status: "unread",
            read_at: null,
            created_at: "2026-08-19T07:13:10Z"
          },
          {
            id: 2,
            subject: "already seen",
            status: "read",
            created_at: "2026-08-18T07:13:10Z"
          }
        ])
      })
    )
    await signedIn(store)

    const outcome = await controller.commands.run("notifications.list")
    expect(outcome.status).toBe("executed")
    await settled()

    const card = notificationsCard(store)
    expect(card?.payload.items).toEqual([
      {
        id: "1",
        title: "canary fixture: issue canary ui needs you",
        repo: null,
        reason: null,
        createdAt: "2026-08-19T07:13:10Z",
        read: false
      },
      { id: "2", title: "already seen", repo: null, reason: null, createdAt: "2026-08-18T07:13:10Z", read: true }
    ])
    expect(card?.payload.unread).toBe(1)
  })

  test("rows that arrive unreadable are said so, never rendered as an empty inbox", async () => {
    const { store, controller } = await freshController(
      backend({ "/api/notifications/list": json(200, [{ nope: true }, { also: "nope" }]) })
    )
    await signedIn(store)

    const outcome = await controller.commands.run("notifications.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain("2 rows")
    await settled()
    expect(store.collections.cards.get("notifications")).toBeUndefined()
  })

  test("a genuinely empty inbox is still an empty card", async () => {
    const { store, controller } = await freshController(
      backend({ "/api/notifications/list": json(200, []) })
    )
    await signedIn(store)
    expect((await controller.commands.run("notifications.list")).status).toBe("executed")
    await settled()
    expect(notificationsCard(store)?.payload.items).toEqual([])
  })

  test("a 500 answers the server's honest message and surfaces no card", async () => {
    const { store, controller } = await freshController(
      backend({ "/api/notifications/list": json(500, { message: "the notifications backfill is rebuilding" }) })
    )
    await signedIn(store)

    const outcome = await controller.commands.run("notifications.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("the notifications backfill is rebuilding")
    await settled()
    expect(store.collections.cards.get("notifications")).toBeUndefined()
  })

  test("a network throw answers the honest string, never a rejection", async () => {
    const { store, controller } = await freshController(
      backend({
        "/api/notifications/list": () => {
          throw new TypeError("fetch failed")
        }
      })
    )
    await signedIn(store)

    const outcome = await controller.commands.run("notifications.list")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Your notifications couldn't be loaded — the platform didn't answer.")
    }
  })
})

describe("notifications.read", () => {
  test("PUTs mark-read, then re-fetches so the card states the platform's answer", async () => {
    const recorded: RecordedRequest[] = []
    let marked = false
    const { store, controller } = await freshController(
      backend(
        {
          "/api/notifications/list": () => json(200, marked ? readInbox : wireInbox),
          "/api/notifications/mark-read": () => {
            marked = true
            return new Response(null, { status: 205 })
          }
        },
        recorded
      )
    )
    await signedIn(store)

    await controller.commands.run("notifications.list")
    await settled()
    expect(notificationsCard(store)?.payload.unread).toBe(2)
    const ordinalBefore = notificationsCard(store)?.ordinal ?? -1

    const outcome = await controller.commands.run("notifications.read")
    expect(outcome.status).toBe("executed")
    await settled()

    const card = notificationsCard(store)
    expect(card?.payload.unread).toBe(0)
    expect(card?.payload.items.map((item) => item.read)).toEqual([true, true, true])
    // The refreshed card re-surfaces at the end of the transcript.
    expect(card?.ordinal ?? -1).toBeGreaterThan(ordinalBefore)

    const notificationCalls = recorded
      .filter((request) => request.path.startsWith("/api/notifications/"))
      .map((request) => `${request.method} ${request.path.split("?")[0]}`)
    expect(notificationCalls).toEqual([
      "GET /api/notifications/list",
      "PUT /api/notifications/mark-read",
      "GET /api/notifications/list"
    ])
  })

  test("a failed mark-read answers the honest message and leaves the card untouched", async () => {
    const recorded: RecordedRequest[] = []
    const { store, controller } = await freshController(
      backend(
        {
          "/api/notifications/list": json(200, wireInbox),
          "/api/notifications/mark-read": json(500, { error: "mark-read is down" })
        },
        recorded
      )
    )
    await signedIn(store)

    await controller.commands.run("notifications.list")
    await settled()

    const outcome = await controller.commands.run("notifications.read")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toBe("mark-read is down")
    await settled()

    // Still the pre-mark-read card, and no re-fetch happened after the failure.
    expect(notificationsCard(store)?.payload.unread).toBe(2)
    const listCalls = recorded.filter((request) => request.path.startsWith("/api/notifications/list"))
    expect(listCalls).toHaveLength(1)
  })

  test("a network throw on mark-read answers the honest string", async () => {
    const { store, controller } = await freshController(
      backend({
        "/api/notifications/mark-read": () => {
          throw new TypeError("fetch failed")
        }
      })
    )
    await signedIn(store)

    const outcome = await controller.commands.run("notifications.read")
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Your notifications couldn't be marked read — the platform didn't answer.")
    }
  })
})
