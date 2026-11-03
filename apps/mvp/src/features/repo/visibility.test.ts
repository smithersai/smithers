import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Collection } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Schema } from "effect"
import { expect, test } from "vitest"
import { RepoRole, Session as SessionRow, type Session } from "../auth/schema"
import { ROLES } from "../auth/contract"
import { makeVisibility } from "./gate"
import { repoVisibility } from "./visibility"

// Decision 0110, 2026-11-03: what of a repository shows is decided by one rule, which the data gate's visibility rows
// follow (gate.ts), so a store nobody wired or a late write can't display anything. These tests hold the rule.

const STATUSES = ["loading", "signed_in", "signed_out", "unreachable"] as const
const session = (status: Session["status"], unverifiable: boolean | undefined): Session => ({
  id: "session", status, role: null, login: null, available: true, signingOut: false, restored: true,
  ...(unverifiable === undefined ? {} : { unverifiable }),
})

/** Every role row the rule reads: none, and each combination of the fields it looks at. */
const rows = (): ReadonlyArray<RepoRole | undefined> => {
  const out: Array<RepoRole | undefined> = [undefined]
  for (const role of [null, ...ROLES]) for (const readable of [undefined, false, true]) {
    for (const refused of [undefined, "authentication", "forbidden"] as const) for (const failure of [undefined, "unavailable"]) {
      out.push({
        id: "github/acme/repo", role, own: false,
        ...(readable === undefined ? {} : { readable }),
        ...(refused === undefined ? {} : { refused }),
        ...(failure === undefined ? {} : { failure }),
      })
    }
  }
  return out
}

/** The rule, stated again over its inputs. */
const expected = (s: Session, row: RepoRole | undefined) => {
  if (row?.refused === "forbidden") return "refused"
  if (s.status === "signed_out" && row?.refused === "authentication") return "sign_in"
  // An answer: no role, and no public read.
  if (row !== undefined && row.failure === undefined && row.refused === undefined && row.role === null && row.readable !== true) {
    return s.status === "signed_out" ? "sign_in" : "refused"
  }
  const publicRead = row !== undefined && row.role === null && row.readable === true && row.refused === undefined
  return s.status === "unreachable" && s.unverifiable === true && !publicRead ? "unverified" : "show"
}

test("the rule over every session state and every role row it reads", () => {
  let cases = 0
  for (const status of STATUSES) for (const unverifiable of [undefined, false, true]) for (const row of rows()) {
    expect([status, unverifiable, row, repoVisibility(session(status, unverifiable), row)])
      .toEqual([status, unverifiable, row, expected(session(status, unverifiable), row)])
    cases++
  }
  expect(cases).toBe(STATUSES.length * 3 * (1 + 5 * 3 * 3 * 2))
  // The cases the decision names, spelled out.
  const member: RepoRole = { id: "r", role: "member", own: false }
  expect(repoVisibility(session("unreachable", false), member)).toBe("show")
  expect(repoVisibility(session("unreachable", true), member)).toBe("unverified")
  expect(repoVisibility(session("unreachable", true), { id: "r", role: null, own: false, readable: true })).toBe("show")
  expect(repoVisibility(session("signed_in", undefined), { ...member, refused: "forbidden" })).toBe("refused")
  expect(repoVisibility(session("signed_in", undefined), { ...member, refused: "authentication" })).toBe("show")
  expect(repoVisibility(session("signed_out", undefined), { ...member, refused: "authentication" })).toBe("sign_in")
  // An answer that grants nothing hides the repository (Astra on 0c7b9f01), with or without a mark; a public read shows.
  expect(repoVisibility(session("signed_in", undefined), { id: "r", role: null, own: false, readable: false })).toBe("refused")
  expect(repoVisibility(session("signed_in", undefined), { id: "r", role: null, own: true })).toBe("refused")
  expect(repoVisibility(session("signed_out", undefined), { id: "r", role: null, own: false, readable: false })).toBe("sign_in")
  expect(repoVisibility(session("signed_in", undefined), { id: "r", role: null, own: false, readable: true })).toBe("show")
  // No answer yet, or a failed read, still shows (decision 0110).
  expect(repoVisibility(session("signed_in", undefined), undefined)).toBe("show")
  expect(repoVisibility(session("signed_in", undefined), { id: "r", role: null, own: false, failure: "unavailable" })).toBe("show")
})

// Astra on 19af7eb9: on a cold load, rows the device restored could show before its stored refusal marks were applied.
// The gate stays closed until they are (`known`, RepoStore's `refusalsKnown`), then opens each repository by the rule.
test("the gate shows nothing until the device's refusals are known, then only what the rule shows", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const known = yield* Deferred.make<void>()
    const roles = yield* Collection.local<RepoRole, string>({ id: `roles-${crypto.randomUUID()}`, schema: RepoRole, getKey: (row) => row.id })
    const sessions = yield* Collection.local<Session, string>({
      id: `session-${crypto.randomUUID()}`, schema: SessionRow, getKey: (row) => row.id, initialData: [session("signed_in", undefined)],
    })
    const Row = Schema.Struct({ id: Schema.String, repoId: Schema.String })
    // Restored before the marks: one row of a repository the person was refused, one of another.
    const rows = yield* Collection.local<typeof Row.Type, string>({
      id: `rows-${crypto.randomUUID()}`, schema: Row, getKey: (row) => row.id,
      initialData: [{ id: "refused-row", repoId: "github/acme/refused" }, { id: "open-row", repoId: "github/acme/open" }],
    })
    const visibility = yield* makeVisibility(roles, sessions, Deferred.await(known))
    const gated = yield* visibility.gate(rows)
    gated.tanstack.startSyncImmediate()
    const ids = Effect.map(gated.toArray, (shown) => shown.map((row) => row.id).sort())
    const before = yield* ids
    // The marks are applied, then they are known.
    yield* Effect.orDie(roles.insert({ id: "github/acme/refused", role: null, own: false, refused: "forbidden" }))
    yield* Deferred.succeed(known, undefined)
    // The gate opens on the fiber that awaits `known`: wait for that, not for a count of yields.
    let after = yield* ids
    for (let turn = 0; turn < 1000 && after.length === 0; turn++) {
      yield* Effect.yieldNow
      after = yield* ids
    }
    return { before, after }
  })))
  expect(result).toEqual({ before: [], after: ["open-row"] })
})

// --- The code. What a page may show is the data gate's (src/device/dataGate.test.ts walks it); the route gate gives a
// repository's pages their states (sign in, Can't check), so every route of a repository is built with it.

const SRC = resolve(import.meta.dirname, "../..")

test("every route of a repository is built with the gate", () => {
  const router = readFileSync(join(SRC, "router.tsx"), "utf8")
  const routes = [...router.matchAll(/createRoute\(\{([\s\S]*?)\n\}\)|createRoute\(\{([\s\S]*?)\n  \}\)/g)].map((match) => match[1] ?? match[2] ?? "")
  const paths = readFileSync(join(SRC, "routePaths.ts"), "utf8")
  const repoKeys = new Set([...paths.matchAll(/^\s*(\w+): "\/\$owner\/\$repo[^"]*"/gm)].map((match) => match[1]!))
  let checked = 0
  for (const route of routes) {
    const key = /path: ROUTE_PATHS\.(\w+)/.exec(route)?.[1]
    if (key === undefined || !repoKeys.has(key) || !/component:/.test(route)) continue
    checked++
    expect([key, /component: repoGated\(/.test(route)]).toEqual([key, true])
  }
  expect(checked).toBeGreaterThan(5)
})
