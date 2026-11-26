import { describe, expect, it } from "vitest"
import { Effect, Layer, Option, Queue, Schema } from "effect"
import { TabChannel } from "@smthrs/platform-browser"
import type { SharedSqlite } from "@smthrs/platform-browser"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Schema as FuzzSchema } from "effect"

interface FuzzInput {
  boolean: () => boolean
  integer: (min: number, max: number) => number
  choice: <T>(items: ReadonlyArray<T>) => T
  string: (opts?: { minLength?: number; maxLength?: number }) => string
}

const makeFuzzInput = (seed: number): FuzzInput => {
  let s = (seed | 0) ^ 0x9e3779b9
  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    boolean: () => next() < 0.5,
    integer: (min, max) => min + Math.floor(next() * (max - min + 1)),
    choice: <T>(items: ReadonlyArray<T>) => items[Math.floor(next() * items.length)]!,
    string: (opts) => {
      const min = opts?.minLength ?? 1
      const max = opts?.maxLength ?? 12
      const len = min + Math.floor(next() * (max - min + 1))
      const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-_"
      let out = ""
      for (let i = 0; i < len; i++) out += alphabet[Math.floor(next() * alphabet.length)]!
      return out
    },
  }
}

const fuzz = async (
  body: (input: FuzzInput) => Promise<void>,
  opts: { executions: number; seed: number },
): Promise<void> => {
  const arb = Arbitrary.schema(FuzzSchema.Int)
  const report = await Effect.runPromise(
    Fuzz.run(
      arb,
      (n) => Effect.promise(async () => { await body(makeFuzzInput(n ^ opts.seed)); return true }),
      { executions: opts.executions, seed: opts.seed },
    ),
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}
import {
  ACCEPTS_HEADER,
  CONFIRM_401_HEADER,
  DEVICE_PERSON_HEADER,
  NO_DEVICE_DATA,
  SESSION_CHECK_HEADER,
  SESSION_ROUTE,
  SIGN_OUT_ROUTE,
  type SessionState,
} from "./features/auth/contract.ts"
import * as Identity from "./device/identity.ts"
import * as Registry from "./device/registry.ts"
import * as AskingTab from "./flows/askingTab.vibe"
import { DOORS } from "./flows/contract.ts"
import { TabRequests } from "./flows/requests.ts"

const ORIGIN = "https://smithers.test"

interface FakeDbState {
  tables: Set<string>
  ownerRow?: {
    v: number
    personId: string
    login: string
    ownsUnstamped: number
    sessionTag: string | null
  }
  hasOwnsUnstampedCol: boolean
  hasSessionTagCol: boolean
  registryRows: Array<{ collection_id: string; table_name: string }>
  confirmedValue?: string
  failOn?: string
}

const makeFakeSqlite = (state: FakeDbState): SharedSqlite.Service => ({
  execute: (sql: string, params?: ReadonlyArray<unknown>) =>
    Effect.suspend((): Effect.Effect<ReadonlyArray<unknown>> => {
      if (state.failOn && sql.includes(state.failOn)) {
        return Effect.fail(new Error("sqlite_io_error") as never)
      }
      if (sql.startsWith("CREATE TABLE IF NOT EXISTS")) {
        state.tables.add("smithers_device_identity")
        return Effect.succeed([])
      }
      if (sql.startsWith("PRAGMA table_info")) {
        const cols: Array<{ name: string }> = [
          { name: "singleton" },
          { name: "v" },
          { name: "person_id" },
          { name: "login" },
        ]
        if (state.hasOwnsUnstampedCol) cols.push({ name: "owns_unstamped" })
        if (state.hasSessionTagCol) cols.push({ name: "session_tag" })
        return Effect.succeed(cols)
      }
      if (sql.includes("ADD COLUMN owns_unstamped")) {
        state.hasOwnsUnstampedCol = true
        return Effect.succeed([])
      }
      if (sql.includes("ADD COLUMN session_tag")) {
        state.hasSessionTagCol = true
        return Effect.succeed([])
      }
      if (sql.includes("FROM smithers_device_identity WHERE singleton = 1")) {
        return Effect.succeed(state.ownerRow ? [state.ownerRow] : [])
      }
      if (sql.includes("INSERT OR REPLACE INTO smithers_device_identity")) {
        const [personId, login, ownsUnstamped] = (params ?? []) as [string, string, number]
        state.ownerRow = {
          v: 1,
          personId,
          login,
          ownsUnstamped,
          sessionTag: null,
        }
        return Effect.succeed([])
      }
      if (sql.includes("UPDATE smithers_device_identity SET session_tag")) {
        const [sessionTag] = (params ?? []) as [string, string]
        if (state.ownerRow) state.ownerRow.sessionTag = sessionTag
        return Effect.succeed([])
      }
      if (sql.includes("FROM sqlite_master")) {
        const [name] = (params ?? []) as [string]
        return Effect.succeed(state.tables.has(name) ? [{ name }] : [])
      }
      if (sql.includes("FROM collection_registry WHERE collection_id = 'auth-confirmed'")) {
        const hit = state.registryRows.find((r) => r.collection_id === "auth-confirmed")
        return Effect.succeed(hit ? [{ tableName: hit.table_name }] : [])
      }
      if (sql.includes("FROM collection_registry WHERE collection_id NOT IN")) {
        const others = state.registryRows.filter(
          (r) => r.collection_id !== "preferences" && r.collection_id !== "auth-confirmed",
        )
        return Effect.succeed(others.map((r) => ({ collection_id: r.collection_id })))
      }
      if (sql.startsWith("SELECT value FROM")) {
        return Effect.succeed(state.confirmedValue !== undefined ? [{ value: state.confirmedValue }] : [])
      }
      return Effect.succeed([])
    }),
  transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
} as unknown as SharedSqlite.Service)

describe("DeviceIdentityDeep fuzz suite", () => {
  it("fuzzes Identity.authorizeDevice across legacy, owner, visitor, offline, error, and storage branches", async () => {
    await fuzz(
      async (input) => {
        const variant = input.choice([
          "new_signed_in",
          "existing_owner_same",
          "existing_owner_different",
          "existing_owner_offline_status",
          "existing_owner_offline_net",
          "existing_owner_signed_out",
          "visitor_adopted",
          "visitor_signed_out",
          "legacy_confirmed_person_match",
          "legacy_confirmed_login_match",
          "legacy_confirmed_mismatch",
          "legacy_unowned_offline",
          "legacy_unowned_signed_out",
          "legacy_unowned_signed_in",
          "missing_person_id",
          "storage_failure",
        ] as const)

        const tag = "0123456789abcdef0123456789abcdef"
        const state: FakeDbState = {
          tables: new Set(),
          hasOwnsUnstampedCol: input.boolean(),
          hasSessionTagCol: input.boolean(),
          registryRows: [],
        }

        let sessionEff: Effect.Effect<SessionState, unknown> = Effect.succeed({ signedIn: false, available: true })

        switch (variant) {
          case "new_signed_in":
            sessionEff = Effect.succeed({ signedIn: true, personId: "p-1", login: "alice", role: "member", session: tag })
            break
          case "existing_owner_same":
            state.ownerRow = { v: 1, personId: "p-1", login: "alice", ownsUnstamped: 1, sessionTag: tag }
            sessionEff = Effect.succeed({ signedIn: true, personId: "p-1", login: "alice", role: "member", session: tag })
            break
          case "existing_owner_different":
            state.ownerRow = { v: 1, personId: "p-1", login: "alice", ownsUnstamped: 1, sessionTag: tag }
            sessionEff = Effect.succeed({ signedIn: true, personId: "p-2", login: "bob", role: "member" })
            break
          case "existing_owner_offline_status":
            state.ownerRow = { v: 1, personId: "p-1", login: "alice", ownsUnstamped: 1, sessionTag: null }
            sessionEff = Effect.fail({ status: 503, message: "down" })
            break
          case "existing_owner_offline_net":
            state.ownerRow = { v: 1, personId: "p-1", login: "alice", ownsUnstamped: 0, sessionTag: null }
            sessionEff = Effect.fail(new Error("offline"))
            break
          case "existing_owner_signed_out":
            state.ownerRow = { v: 1, personId: "p-1", login: "alice", ownsUnstamped: 1, sessionTag: null }
            sessionEff = Effect.succeed({ signedIn: false, available: true })
            break
          case "visitor_adopted":
            state.ownerRow = { v: 1, personId: Identity.VISITOR, login: "", ownsUnstamped: 0, sessionTag: null }
            sessionEff = Effect.succeed({ signedIn: true, personId: "p-1", login: "alice", role: "member", session: tag })
            break
          case "visitor_signed_out":
            state.ownerRow = { v: 1, personId: Identity.VISITOR, login: "", ownsUnstamped: 0, sessionTag: null }
            sessionEff = Effect.succeed({ signedIn: false, available: true })
            break
          case "legacy_confirmed_person_match":
            state.tables.add("collection_registry")
            state.tables.add("col_auth_confirmed")
            state.registryRows.push({ collection_id: "auth-confirmed", table_name: "col_auth_confirmed" })
            state.confirmedValue = JSON.stringify({ id: "session", login: "alice", personId: "p-1", role: "member" })
            sessionEff = Effect.succeed({ signedIn: true, personId: "p-1", login: "alice-renamed", role: "member" })
            break
          case "legacy_confirmed_login_match":
            state.tables.add("collection_registry")
            state.tables.add("col_auth_confirmed")
            state.registryRows.push({ collection_id: "auth-confirmed", table_name: "col_auth_confirmed" })
            state.confirmedValue = JSON.stringify({ id: "session", login: "Alice", role: "member" })
            sessionEff = Effect.succeed({ signedIn: true, personId: "p-1", login: "alice", role: "member" })
            break
          case "legacy_confirmed_mismatch":
            state.tables.add("collection_registry")
            state.tables.add("col_auth_confirmed")
            state.registryRows.push({ collection_id: "auth-confirmed", table_name: "col_auth_confirmed" })
            state.confirmedValue = JSON.stringify({ id: "session", login: "alice", personId: "p-1", role: "member" })
            sessionEff = Effect.succeed({ signedIn: true, personId: "p-9", login: "eve", role: "member" })
            break
          case "legacy_unowned_offline":
            state.tables.add("collection_registry")
            state.registryRows.push({ collection_id: "messages", table_name: "col_messages" })
            sessionEff = Effect.fail(new Error("offline"))
            break
          case "legacy_unowned_signed_out":
            state.tables.add("collection_registry")
            state.registryRows.push({ collection_id: "messages", table_name: "col_messages" })
            sessionEff = Effect.succeed({ signedIn: false, available: true })
            break
          case "legacy_unowned_signed_in":
            state.tables.add("collection_registry")
            state.registryRows.push({ collection_id: "messages", table_name: "col_messages" })
            sessionEff = Effect.succeed({ signedIn: true, personId: "p-1", login: "alice", role: "member" })
            break
          case "missing_person_id":
            sessionEff = Effect.succeed({ signedIn: true, login: "alice", role: "member" } as unknown as SessionState)
            break
          case "storage_failure":
            state.failOn = "CREATE TABLE"
            break
        }

        const reports: Array<{ owner: string | undefined; outcome: Identity.Outcome; continuous: boolean }> = []
        const exit = await Effect.runPromiseExit(
          Identity.authorizeDevice({
            database: makeFakeSqlite(state),
            session: sessionEff,
            report: (owner, outcome, continuous) => {
              reports.push({ owner, outcome, continuous })
            },
          }),
        )

        if (
          variant === "new_signed_in" ||
          variant === "existing_owner_same" ||
          variant === "existing_owner_offline_status" ||
          variant === "existing_owner_offline_net" ||
          variant === "visitor_adopted" ||
          variant === "visitor_signed_out" ||
          variant === "legacy_confirmed_person_match" ||
          variant === "legacy_confirmed_login_match"
        ) {
          expect(exit._tag).toBe("Success")
          expect(reports.length).toBe(1)
        } else {
          expect(exit._tag).toBe("Failure")
        }
      },
      { executions: 60, seed: 51001 },
    )
  })

  it("fuzzes Identity.boundFetch credential_stale, CONFIRM_401, adoption, signOut, and reopen recovery", async () => {
    await fuzz(
      async (input) => {
        const scenario = input.choice([
          "credential_stale_future_then_recover",
          "credential_stale_http_date",
          "credential_stale_signed_out_on_reread",
          "credential_stale_wrong_person_on_reread",
          "credential_stale_transient_no_device_data",
          "credential_storage_fail_then_get_recovers",
          "credential_lock_cancelled",
          "confirm_401_same_person",
          "confirm_401_signed_out",
          "confirm_401_unchecked",
          "visitor_adopt_adopted",
          "visitor_adopt_unavailable",
          "visitor_adopt_refused_reopen_true",
          "reauthorize_held_back_false",
          "reauthorize_throws",
          "sign_out_hook",
          "cross_origin_strips_confirm_header",
        ] as const)

        const store = new Map<string, string>()
        let failSetOnce = scenario === "credential_storage_fail_then_get_recovers"
        let currentPrincipal =
          scenario === "credential_stale_transient_no_device_data"
            ? NO_DEVICE_DATA
            : scenario.startsWith("visitor_adopt")
              ? Identity.VISITOR
              : "p-1"
        const sessionTag = "abcdef0123456789abcdef0123456789"
        let reopenCalls = 0
        let signOutHookCalls = 0
        let nowMs = 1_700_000_000_000
        const advanceClock = async (ms: number) => {
          nowMs += ms
          await Promise.resolve()
          await Promise.resolve()
        }
        let postCount = 0

        const nextFetch: typeof globalThis.fetch = async (reqInput) => {
          const req = new Request(reqInput)
          const url = new URL(req.url)
          if (url.pathname === SESSION_ROUTE) {
            if (scenario === "confirm_401_unchecked") {
              throw new Error("network down")
            }
            if (scenario === "confirm_401_signed_out" || scenario === "credential_stale_signed_out_on_reread") {
              return new Response(JSON.stringify({ signedIn: false, available: true }), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            }
            if (scenario === "credential_stale_wrong_person_on_reread") {
              return new Response(JSON.stringify({ signedIn: true, personId: "p-other", login: "bob", role: "member" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            }
            if (scenario === "visitor_adopt_adopted" || scenario === "visitor_adopt_unavailable" || scenario === "visitor_adopt_refused_reopen_true") {
              return new Response(JSON.stringify({ signedIn: true, personId: "p-new", login: "carol", role: "member" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            }
            if (scenario === "reauthorize_held_back_false" || scenario === "reauthorize_throws") {
              return new Response(JSON.stringify({ signedIn: true, personId: "p-2", login: "bob", role: "member" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            }
            return new Response(JSON.stringify({ signedIn: true, personId: "p-1", login: "alice", role: "member" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          }
          if (url.pathname === SIGN_OUT_ROUTE) {
            return new Response(null, { status: 204 })
          }
          if (url.pathname === "/api/write") {
            postCount++
            if (
              (scenario === "credential_stale_future_then_recover" ||
                scenario === "credential_stale_signed_out_on_reread" ||
                scenario === "credential_stale_wrong_person_on_reread" ||
                scenario === "credential_stale_transient_no_device_data" ||
                scenario === "credential_storage_fail_then_get_recovers") &&
              postCount === 1
            ) {
              return new Response(null, {
                status: 503,
                headers: {
                  "x-smithers-credential": "stale",
                  "retry-after": "0",
                },
              })
            }
            if (scenario === "credential_stale_http_date" && postCount === 1) {
              return new Response(null, {
                status: 503,
                headers: {
                  "x-smithers-credential": "stale",
                  "retry-after": new Date(nowMs + 60_000).toUTCString(),
                },
              })
            }
            if (scenario.startsWith("confirm_401")) {
              return new Response("unauthorized", { status: 401 })
            }
            return new Response(JSON.stringify({ ok: true, header: req.headers.get(DEVICE_PERSON_HEADER) }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          }
          return new Response("ok", { status: 200 })
        }

        const bound = Identity.boundFetch(nextFetch, {
          origin: ORIGIN,
          now: () => nowMs,
          principal: () => currentPrincipal,
          sessionTag: () => sessionTag,
          credentialStorage: {
            get: async (k) => store.get(k) ?? null,
            set: async (k, v) => {
              if (failSetOnce) {
                failSetOnce = false
                throw new Error("storage_locked")
              }
              store.set(k, v)
            },
          },
          withCredential: async (action, signal) => {
            if (scenario === "credential_lock_cancelled" && signal) {
              throw new Error("aborted")
            }
            return action()
          },
          signOut: async (send) => {
            signOutHookCalls++
            return send()
          },
          reauthorize: async () => {
            reopenCalls++
            if (scenario === "reauthorize_held_back_false") return false
            if (scenario === "reauthorize_throws") throw new Error("reopen_boom")
            return true
          },
          reopensOnSignIn: () => false,
          adopt: async () => {
            if (scenario === "visitor_adopt_adopted") {
              currentPrincipal = "p-new"
              return "adopted"
            }
            if (scenario === "visitor_adopt_unavailable") return "unavailable"
            return "refused"
          },
        })

        if (scenario === "cross_origin_strips_confirm_header") {
          const res = await bound("https://other.example/x", { headers: { [CONFIRM_401_HEADER]: "1" } })
          expect(res.status).toBe(200)
          return
        }

        if (scenario === "sign_out_hook") {
          const res = await bound(`${ORIGIN}${SIGN_OUT_ROUTE}`, { method: "POST" })
          expect(res.status).toBe(204)
          expect(signOutHookCalls).toBe(1)
          return
        }

        if (scenario === "credential_lock_cancelled") {
          const ac = new AbortController()
          ac.abort()
          await expect(bound(`${ORIGIN}/api/write`, { method: "POST", signal: ac.signal })).rejects.toMatchObject({
            _tag: "DeviceIdentityRefused",
            reason: "credential_stale",
            stage: "credential_lock",
            wait: "cancelled",
          })
          return
        }

        if (scenario === "credential_stale_future_then_recover" || scenario === "credential_stale_transient_no_device_data") {
          if (scenario === "credential_stale_transient_no_device_data") {
            await bound(`${ORIGIN}${SESSION_ROUTE}`)
          }
          await expect(bound(`${ORIGIN}/api/write`, { method: "POST" })).rejects.toMatchObject({
            reason: "credential_stale",
          })
          await advanceClock(5)
          const okRes = await bound(`${ORIGIN}/api/write`, { method: "POST" })
          expect(okRes.status).toBe(200)
          return
        }

        if (scenario === "credential_stale_http_date") {
          await expect(bound(`${ORIGIN}/api/write`, { method: "POST" })).rejects.toMatchObject({
            reason: "credential_stale",
          })
          await advanceClock(5)
          await expect(bound(`${ORIGIN}/api/write`, { method: "POST" })).rejects.toMatchObject({
            reason: "credential_stale",
          })
          return
        }

        if (scenario === "credential_stale_signed_out_on_reread") {
          await expect(bound(`${ORIGIN}/api/write`, { method: "POST" })).rejects.toMatchObject({
            reason: "credential_stale",
          })
          await advanceClock(5)
          await expect(bound(`${ORIGIN}/api/write`, { method: "POST" })).rejects.toMatchObject({
            reason: "signed_out",
          })
          expect(reopenCalls).toBeGreaterThanOrEqual(1)
          return
        }

        if (scenario === "credential_stale_wrong_person_on_reread") {
          await expect(bound(`${ORIGIN}/api/write`, { method: "POST" })).rejects.toMatchObject({
            reason: "credential_stale",
          })
          await advanceClock(5)
          await expect(bound(`${ORIGIN}/api/write`, { method: "POST" })).rejects.toMatchObject({
            _tag: "DeviceIdentityRefused",
          })
          return
        }

        if (scenario === "credential_storage_fail_then_get_recovers") {
          await expect(bound(`${ORIGIN}/api/write`, { method: "POST" })).rejects.toMatchObject({
            reason: "credential_stale",
          })
          await advanceClock(5)
          const getRes = await bound(`${ORIGIN}/api/read`)
          expect(getRes.status).toBe(200)
          await advanceClock(5)
          const writeRes = await bound(`${ORIGIN}/api/write`, { method: "POST" })
          expect(writeRes.status).toBe(200)
          return
        }

        if (scenario === "confirm_401_same_person") {
          const res = await bound(`${ORIGIN}/api/write`, {
            method: "POST",
            headers: { [CONFIRM_401_HEADER]: "1", [ACCEPTS_HEADER]: "credential-stale" },
          })
          expect(res.status).toBe(401)
          expect(res.headers.get(SESSION_CHECK_HEADER)).toBe("same_person")
          return
        }

        if (scenario === "confirm_401_signed_out") {
          await expect(
            bound(`${ORIGIN}/api/write`, { method: "POST", headers: { [CONFIRM_401_HEADER]: "1" } }),
          ).rejects.toMatchObject({ reason: "signed_out" })
          return
        }

        if (scenario === "confirm_401_unchecked") {
          await expect(
            bound(`${ORIGIN}/api/write`, { method: "POST", headers: { [CONFIRM_401_HEADER]: "1" } }),
          ).rejects.toMatchObject({ reason: "unchecked" })
          return
        }

        if (scenario === "visitor_adopt_adopted") {
          const res = await bound(`${ORIGIN}${SESSION_ROUTE}`)
          expect(res.status).toBe(200)
          return
        }

        if (scenario === "visitor_adopt_unavailable") {
          await expect(bound(`${ORIGIN}${SESSION_ROUTE}`)).rejects.toMatchObject({ reason: "adopting" })
          return
        }

        if (scenario === "visitor_adopt_refused_reopen_true") {
          await expect(bound(`${ORIGIN}${SESSION_ROUTE}`)).rejects.toMatchObject({ reason: "reauthorizing" })
          await expect(bound(`${ORIGIN}/api/read`)).rejects.toMatchObject({ reason: "reauthorizing" })
          return
        }

        if (scenario === "reauthorize_held_back_false") {
          await expect(bound(`${ORIGIN}${SESSION_ROUTE}`)).rejects.toMatchObject({ reason: "reauthorizing" })
          // Because reauthorize returned false, recovering was cleared so subsequent non-session GET succeeds
          const res = await bound(`${ORIGIN}/api/read`)
          expect(res.status).toBe(200)
          return
        }

        if (scenario === "reauthorize_throws") {
          await expect(bound(`${ORIGIN}${SESSION_ROUTE}`)).rejects.toThrow("reopen_boom")
          return
        }
      },
      { executions: 50, seed: 51002 },
    )
  })

  it("fuzzes AskingTab asker and answerAskingTab over in-memory TabChannel", async () => {
    await fuzz(
      async (input) => {
        const channel = `ask-${input.integer(1, 50)}`
        const reqId = `req-${input.integer(1, 100)}`
        const validInput = input.boolean()
        const knownRequester = input.boolean()
        const payload = input.string({ minLength: 1, maxLength: 16 })

        const tabRequestsLayer = Layer.succeed(
          TabRequests,
          TabRequests.of({
            register: () => Effect.void,
            doorOf: (id: string) => Effect.succeed(knownRequester && id === reqId ? Option.some(DOORS[0]!) : Option.none()),
          } as never),
        )

        const res = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              yield* AskingTab.answerAskingTab({
                channel,
                input: Schema.Struct({ text: Schema.String }),
                answer: (inp, door) => Effect.succeed({ echoed: `${door}:${inp.text}` }),
              })
              yield* Effect.yieldNow
              const ask = yield* AskingTab.asker<{ readonly text?: string }, Schema.Struct<{ readonly echoed: Schema.String }>>({
                channel,
                output: Schema.Struct({ echoed: Schema.String }),
                within: "50 millis",
              })
              return yield* ask(reqId, validInput ? { text: payload } : ({} as never))
            }),
          ).pipe(Effect.provide(Layer.mergeAll(
            Layer.succeed(TabChannel.TabChannel, (() => {
              const listeners = new Map<string, Set<Queue.Queue<unknown>>>()
              return TabChannel.TabChannel.of({
                open: (name: string) => Effect.succeed({
                  post: (msg: unknown) => Effect.forEach([...(listeners.get(name) ?? [])], (q) => Queue.offer(q, msg), { discard: true }),
                  subscribe: Effect.acquireRelease(
                    Effect.gen(function* () {
                      const q = yield* Queue.unbounded<unknown>()
                      let set = listeners.get(name)
                      if (!set) { set = new Set(); listeners.set(name, set) }
                      set.add(q)
                      return q
                    }),
                    (q) => Effect.sync(() => { listeners.get(name)?.delete(q) }),
                  ),
                }),
              })
            })()),
            tabRequestsLayer,
          ))),
        )

        if (validInput && knownRequester) {
          expect(Option.isSome(res)).toBe(true)
          if (Option.isSome(res)) {
            expect(res.value.door).toBe(DOORS[0]!)
            expect(res.value.output.echoed).toBe(`${DOORS[0]!}:${payload}`)
          }
        } else {
          expect(Option.isNone(res)).toBe(true)
        }
      },
      { executions: 20, seed: 51003 },
    )
  })

  it("fuzzes deviceRegistry key extractors and migrations", async () => {
    await fuzz(
      async (input) => {
        const id = `id-${input.integer(1, 1000)}`
        const owner = input.choice(["acme", "smithersai"])
        const name = input.choice(["repo", "app"])
        for (const col of Object.values(Registry)) {
          const sample = {
            id,
            key: id,
            subject: id,
            repoId: `github/${owner}/${name}`,
            owner,
            name,
            number: input.integer(1, 999),
            sha: "a".repeat(40),
            path: "README.md",
            recipient: "p-1",
            runId: id,
            nameKey: id,
            conversationId: id,
          }
          const k = (col as { getKey?: (row: unknown) => string }).getKey?.(sample)
          if (k !== undefined) expect(typeof k).toBe("string")
        }
        expect(Registry.outboxUpgrade).toBeDefined()
        expect(Object.keys(Registry).length).toBeGreaterThan(10)
      },
      { executions: 15, seed: 51004 },
    )
  })
})
