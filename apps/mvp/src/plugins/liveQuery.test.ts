import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Schema } from "effect"
import { expect, test } from "vitest"
import { RepoRole, Session } from "../features/auth/schema"
import { makeVisibility } from "../features/repo/gate"
import { liveQueryOf } from "./plugins"

// Real TanStack collections and the repository data gate. React requires the same snapshot object until rows
// change, while a permission refusal must hide rows in the same synchronous read, before the stream catches up.
test("plugin snapshots keep their identity until rows change, and a refusal hides rows immediately", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const roles = yield* Collection.local<RepoRole, string>({
      id: `roles-${crypto.randomUUID()}`, schema: RepoRole, getKey: (row) => row.id,
      initialData: [{ id: "github/acme/repo", role: "member", own: false }],
    })
    const session = yield* Collection.local<Session, string>({
      id: `session-${crypto.randomUUID()}`, schema: Session, getKey: (row) => row.id,
      initialData: [{ id: "session", status: "signed_in", role: "member", login: "reader", available: true, signingOut: false, restored: true }],
    })
    const Row = Schema.Struct({ id: Schema.String, repoId: Schema.String, value: Schema.Number })
    const rows = yield* Collection.local<typeof Row.Type, string>({
      id: `rows-${crypto.randomUUID()}`, schema: Row, getKey: (row) => row.id,
    })
    const visibility = yield* makeVisibility(roles, session)
    const gated = yield* visibility.gate(rows)
    const live = yield* liveQueryOf(gated)
    expect(live.current()).toEqual([])
    expect(live.current()).toBe(live.current())

    yield* rows.insert({ id: "a", repoId: "github/acme/repo", value: 1 })
    yield* rows.insert({ id: "b", repoId: "github/acme/repo", value: 2 })
    const before = live.current()
    expect(before.map((row) => row.value)).toEqual([1, 2])
    expect(live.current()).toBe(before)
    yield* rows.update("b", (draft) => { draft.value = 3 })
    const changed = live.current()
    expect(changed).not.toBe(before)
    expect(changed.map((row) => row.value)).toEqual([1, 3])
    expect(live.current()).toBe(changed)

    yield* roles.update("github/acme/repo", (draft) => { draft.refused = "forbidden" })
    // No yield to a stream follower: the permission change must take effect now.
    const refused = live.current()
    expect(refused).toEqual([])
    expect(live.current()).toBe(refused)
    yield* roles.update("github/acme/repo", (draft) => { delete draft.refused })
    expect(live.current().map((row) => row.value)).toEqual([1, 3])
    expect(live.current()).toBe(live.current())
    yield* rows.delete("a")
    yield* rows.delete("b")
    expect(live.current()).toEqual([])
    expect(live.current()).toBe(live.current())
  })))
})
