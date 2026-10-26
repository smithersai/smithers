import { Effect, FiberHandle, Option, Stream } from "effect"
import { Clipboard } from "../../clipboard"
import { codeOf } from "../../errorCode"
import { FlowDispatch } from "../../flows/dispatch"
import { repoId } from "../repo/contract"
import { normalizeHostname } from "./contract"
import type { Domain, DomainOp } from "./schema"
import { DomainsStore, PAGE } from "./store"

// What a Maintainer does on a repository's Settings page (docs/features/domains.md#the-settings-section): open it, add
// a domain, check one again (Refresh), remove one, and copy a DNS record's value. Every write is a flow, `domain/add`
// or `domain/remove`, that returns at once; the page shows it in flight until it lands, or why it didn't.

/** Makes the page's list `rows`. */
const mirror = (rows: ReadonlyArray<Domain>) =>
  Effect.gen(function* () {
    const { list } = yield* DomainsStore
    const keep = new Set(rows.map((row) => row.hostname))
    const gone = (yield* list.toArray).filter((row) => !keep.has(row.hostname)).map((row) => row.hostname)
    if (gone.length > 0) yield* Effect.orDie(list.delete(gone))
    for (const row of rows) {
      if (Option.isSome(yield* list.get(row.hostname))) {
        yield* Effect.orDie(list.update(row.hostname, (draft) => void Object.assign(draft, row)))
      } else {
        yield* Effect.orDie(list.insert(row))
      }
    }
  })

/** Shows repository `owner/name`'s domains on the page, its list kept equal to the repository's while it shows. */
export const open = (owner: string, name: string) =>
  Effect.gen(function* () {
    const store = yield* DomainsStore
    const now = Option.getOrThrow(yield* store.page.get(PAGE))
    // The page's follower keeps running once it started, so showing the same repository again changes nothing.
    if (now.owner === owner && now.name === name) return
    yield* mirror([])
    yield* Effect.orDie(store.page.update(PAGE, (draft) => void Object.assign(draft, { owner, name })))
    const domains = yield* store.domains(repoId(owner, name))
    yield* FiberHandle.run(
      store.follower,
      domains.changes({ initial: true }).pipe(Stream.runForEach(() => Effect.flatMap(domains.toArray, mirror))),
    )
  }).pipe(Effect.annotateLogs({ feature: "domains" }))

/** Each press's span, by what it writes. */
const PRESS: Record<DomainOp, string> = {
  add: "domain.add.press",
  refresh: "domain.refresh.press",
  remove: "domain.remove.press",
}

/** Records `hostname`'s write as `state`, with `code` when it failed. */
const save = (hostname: string, op: DomainOp, state: "saving" | "failed", code: string | null = null) =>
  Effect.gen(function* () {
    const { saves } = yield* DomainsStore
    const row = { hostname, op, state, code }
    if (Option.isSome(yield* saves.get(hostname))) {
      yield* saves.update(hostname, (draft) => void Object.assign(draft, row))
    } else {
      yield* saves.insert(row)
    }
  }).pipe(
    // A local collection refuses only a row its own schema rejects, which these never are: a bug, not a state.
    Effect.orDie,
  )

/**
 * Writes `hostname` on the page's repository through `domain/add` or `domain/remove`. It returns at once; the page shows
 * the write until the flow ends, then the synced row, or why it didn't land, until the next write of that hostname.
 */
const write = (op: DomainOp, hostname: string) =>
  Effect.gen(function* () {
    const { page, saves, scope } = yield* DomainsStore
    const flows = yield* FlowDispatch
    const { owner, name } = Option.getOrThrow(yield* page.get(PAGE))
    yield* save(hostname, op, "saving")
    const flow = op === "remove" ? "domain/remove" : "domain/add"
    yield* flows.dispatch(flow, { owner, name, hostname }, { door: "button" }).pipe(
      Effect.exit,
      // Done removes the write; ChatApi's refusal shows its code; a flow that couldn't run, `unavailable`.
      Effect.flatMap((exit) => {
        if (exit._tag === "Success" && exit.value._tag === "Done") return Effect.ignore(saves.delete(hostname))
        const refused = exit._tag === "Success" && exit.value._tag === "Failed" &&
            exit.value.error._tag === "@smthrs/mvp/domains/DomainRefused"
          ? exit.value.error.code
          : undefined
        return save(hostname, op, "failed", refused ?? "unavailable")
      }),
      Effect.forkIn(scope),
    )
  }).pipe(Effect.withSpan(PRESS[op]), Effect.annotateLogs({ feature: "domains" }))

/** Adds the domain `raw` names to the page's repository. A name that can't be a domain is refused here, unsent. */
export const add = (raw: string) =>
  Effect.gen(function* () {
    const hostname = normalizeHostname(raw)
    if (hostname === undefined) return yield* save(raw.trim().toLowerCase(), "add", "failed", "invalid_hostname")
    yield* write("add", hostname)
  })

/** Checks `hostname`'s DNS again: a new verification. */
export const refresh = (hostname: string) => write("refresh", hostname)

/** Removes `hostname` from the page's repository. */
export const remove = (hostname: string) => write("remove", hostname)

/** Copies `text`, a DNS record's value, through the host's clipboard; `false`, logged by its code, when it refused. */
export const copy = (text: string) =>
  Effect.flatMap(Clipboard, (clipboard) => clipboard.write(text)).pipe(
    Effect.as(true),
    Effect.catch((refused) =>
      Effect.logWarning("domain.copy").pipe(
        Effect.annotateLogs({ feature: "domains", outcome: "failed", errorCode: codeOf(refused) }),
        Effect.as(false),
      )
    ),
  )
