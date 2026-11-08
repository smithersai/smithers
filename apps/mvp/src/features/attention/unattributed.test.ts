import { Collection } from "@smthrs/effect-tanstack-db"
import { Effect } from "effect"
import { expect, test } from "vitest"
import { CloudRun, UNATTRIBUTED_RUN_KINDS } from "../runs/schema"
import { shownQuery } from "./queries"
import { Entry, NoticeKind, UNATTRIBUTED_NOTICE_KINDS } from "./schema"

// The data gate (decision 0110, 2026-11-03; coordinator's rulings 1 and 2): a notice or a run on Cloudflare that names no
// repository shows only for an allowlisted, deployment-level kind. Every kind the schemas know is classified.

test("every notice kind and every Cloudflare run kind is classified, and only deployment-level kinds show unattributed", () => {
  expect(Object.keys(UNATTRIBUTED_NOTICE_KINDS).sort()).toEqual([...NoticeKind.literals].sort())
  expect(Object.keys(UNATTRIBUTED_RUN_KINDS).sort()).toEqual([...CloudRun.fields.kind.literals].sort())
  const shows = (kinds: Readonly<Record<string, string | null>>) => Object.keys(kinds).filter((kind) => kinds[kind] !== null).sort()
  expect(shows(UNATTRIBUTED_NOTICE_KINDS)).toEqual(["bug", "run", "spend"])
  expect(shows(UNATTRIBUTED_RUN_KINDS)).toEqual(["system"])
})

const entry = (id: string, kind: NoticeKind): Entry => ({
  id, kind, state: "done", mine: true, runId: null, conversationId: null, repoId: null, actor: null, atMs: 1, word: null,
  detail: null, action: "open", href: "", version: 1, unread: false, settled: true, stack: false, stackHere: false,
  listed: true, here: false, order: 0,
})

test("a notice naming neither a repository nor a conversation shows only for an allowlisted kind", async () => {
  const shown = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const entries = yield* Collection.local<Entry, string>({
      id: "unattributed-entries",
      schema: Entry,
      getKey: (row) => row.id,
      initialData: NoticeKind.literals.map((kind) => entry(`notice-${kind}`, kind)),
    })
    const none = yield* Collection.local<Entry, string>({ id: "unattributed-none", schema: Entry, getKey: (row) => row.id })
    const query = yield* shownQuery(entries, none, none)
    yield* query.preload
    return (yield* query.toArray).map((row) => row.kind).sort()
  })))
  expect(shown).toEqual(["bug", "run", "spend"])
})
