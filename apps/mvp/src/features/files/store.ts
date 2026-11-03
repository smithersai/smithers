import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import { Context, Effect, Layer, Option, Semaphore, Stream } from "effect"
import { RepoStore } from "../repo/store"
import type { ViewRow } from "../repo/rows"
import { FileTabsStore } from "../../device/registry"
import { repoId } from "../repo/contract"
import type { Source } from "../repo/gate"
import type { FileTabRow, Here } from "./schema"
import { linesOf, tabKey } from "./view"

// This device's open files (docs/features/files.md): the `file-tabs` collection, kept on the device, so every tab of
// the device shows the same strip and a reload keeps it; and a follower that adds a tab for every file the repository
// view opens, however it got there: `file/open`, a link in the file tree, `app/navigate` or the address bar. Each tab
// remembers the lines it last highlighted. Nothing here moves the page; `file/open` and `file/close` do
// (./actions.ts).

/** Every open file on this device whose repository may show, in the order they opened: what frontends read. */
export const tabsQuery = (tabs: Source<FileTabRow>) =>
  LiveQuery.make((q) => q.from({ tab: tabs.tanstack }).orderBy(({ tab }) => tab.position))

/** Whether `view` shows a file whose revision and commit resolved: a page to keep a tab for. */
const fileShown = (view: ViewRow): boolean =>
  view.kind === "blob" && view.revision !== null && view.sha !== null && !view.missing && view.failure === null &&
  view.path !== ""

const make = Effect.gen(function* () {
  const tabs = yield* Collection.persisted(FileTabsStore)
  // Through the data gate (repo/gate.ts): a refused or unverified repository's tabs leave the strip, and stay on the
  // device for when it shows again. A tab without the repository store (a test's) has no refusal to keep.
  const repo = yield* Effect.serviceOption(RepoStore)
  const all = yield* tabsQuery(Option.isSome(repo) ? yield* repo.value.gate(tabs) : tabs)
  // One write at a time, so the follower and an open of one file never both insert it.
  const writes = yield* Semaphore.make(1)

  /** Keeps a tab for `path` at `here` with `lines`: a new one at the strip's end, or the lines of the one it has. */
  const keep = (here: Pick<Here, "owner" | "name" | "revision">, path: string, lines: string | null) =>
    Effect.gen(function* () {
      const key = tabKey(here, path)
      const existing = yield* tabs.get(key)
      if (Option.isSome(existing)) {
        if (existing.value.lines === lines) return
        yield* (yield* tabs.update(key, (draft) => void (draft.lines = lines))).persisted
        return
      }
      const rows = yield* tabs.toArray
      const position = rows.reduce((last, row) => Math.max(last, row.position), 0) + 1
      yield* (yield* tabs.insert({
        key, owner: here.owner, name: here.name, repoId: repoId(here.owner, here.name), revision: here.revision, path, lines, position,
      })).persisted
    }).pipe(
      Semaphore.withPermits(writes, 1),
      // Keep the permit through the device write. Schema/key errors are bugs;
      // persistence failures remain typed so the route follower can keep listening.
      Effect.catchTag("MutationRefused", Effect.die),
    )

  /** Closes `path`'s tab at `here`; whether it had one. */
  const drop = (here: Pick<Here, "owner" | "name" | "revision">, path: string) =>
    Effect.gen(function* () {
      const key = tabKey(here, path)
      if (Option.isNone(yield* tabs.get(key))) return false
      yield* (yield* tabs.delete(key)).persisted
      return true
    }).pipe(Semaphore.withPermits(writes, 1), Effect.orDie)

  // Every file the routed repository view shows gets a tab, with the lines it highlights.
  if (Option.isSome(repo)) {
    yield* repo.value.view.changes({ initial: true }).pipe(
      Stream.runForEach((changes) =>
        Effect.forEach(changes, (change) =>
          // The view's one row is never deleted: each change says where it is now.
          !fileShown(change.value)
            ? Effect.void
            : keep(
              { owner: change.value.owner, name: change.value.name, revision: change.value.revision! },
              change.value.path,
              linesOf(change.value.line, change.value.lineEnd),
            ).pipe(Effect.ignore), { discard: true })
      ),
      Effect.forkScoped,
    )
  }

  return { tabs, all, keep, drop }
})

/**
 * File tabs' state for one tab:
 * - `tabs`: this device's open files, kept on the device.
 * - `all`: the live query of every one whose repository may show (the data gate), in the order they opened.
 * - `keep` and `drop`: a tab kept with its lines, and a tab closed, one write at a time.
 */
export class FilesStore extends Context.Service<FilesStore, Effect.Success<typeof make>>()(
  "@smthrs/mvp/files/FilesStore",
) {
  /** The store, with its follower of the repository view running until the scope closes. */
  static readonly layer = Layer.effect(FilesStore, make)
}
