import { Context, Effect, Layer, Option } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import { RepoStore } from "../repo/store"
import { VIEW } from "../repo/rows"
import type { FilesCall, FilesReply, Here } from "./schema"
import { FilesStore } from "./store"
import { fileHref, hereOf, rootHref, tabsAt } from "./view"

// What file tabs do in the tab (docs/features/files.md): open a file of the repository the tab shows as a tab at its
// lines, and close a tab, moving to the tab beside it when it was the file on screen. The tab answers `file/open` and
// `file/close` with these (./tab.ts); the strip's clicks and keys dispatch those flows (door `button`), so a person and
// the agent go through the same two.

/** The page as file tabs see it: where the tab is, and the router's navigate. */
export class FilesPage extends Context.Service<
  FilesPage,
  {
    /** The repository, revision and location the tab shows; none when it shows no repository. */
    readonly here: Effect.Effect<Option.Option<Here>>
    /** Takes this tab to `path`, an app path. */
    readonly navigate: (path: string) => void
  }
>()("@smthrs/mvp/files/FilesPage") {
  /**
   * The browser's: where the tab is from the router's `pathname` and the repository view's row (`hereOf`); without a
   * `pathname`, nowhere.
   */
  static readonly layer = (host: { readonly pathname?: () => string; readonly navigate: (path: string) => void }) =>
    Layer.effect(
      FilesPage,
      Effect.gen(function* () {
        const repo = yield* RepoStore
        return FilesPage.of({
          here: host.pathname === undefined ? Effect.succeedNone : Effect.map(
            repo.view.get(VIEW),
            Option.flatMap((view) => Option.fromNullishOr(hereOf(host.pathname!(), view))),
          ),
          navigate: host.navigate,
        })
      }),
    )
}

const nowhere: FilesReply = { repository: null, ref: null, done: false }

/** Opens `path` at `here` as a tab with `lines`, and takes the tab to it. */
export const open = (path: string, lines: string | null) =>
  Effect.gen(function* () {
    const page = yield* FilesPage
    const here = yield* page.here
    if (Option.isNone(here)) return nowhere
    yield* (yield* FilesStore).keep(here.value, path, lines).pipe(Effect.orDie)
    page.navigate(fileHref(here.value, path, lines))
    return { repository: `${here.value.owner}/${here.value.name}`, ref: here.value.revision, done: true }
  })

/**
 * Closes `path`'s tab at `here`. When it is the file on screen, the tab takes its place: the next tab, else the one
 * before, else the repository's root.
 */
export const close = (path: string) =>
  Effect.gen(function* () {
    const page = yield* FilesPage
    const store = yield* FilesStore
    const here = yield* page.here
    if (Option.isNone(here)) return nowhere
    const at = here.value
    const strip = tabsAt(yield* store.tabs.toArray, at)
    const index = strip.findIndex((row) => row.path === path)
    const closed = yield* store.drop(at, path)
    if (closed && at.kind === "blob" && at.path === path) {
      const next = strip[index + 1] ?? strip[index - 1]
      page.navigate(next === undefined ? rootHref(at) : fileHref(at, next.path, next.lines))
    }
    return { repository: `${at.owner}/${at.name}`, ref: at.revision, done: closed }
  })

/** What the tab answers a step's call with. */
export const answer = (call: FilesCall) => call.op === "open" ? open(call.path, call.lines ?? null) : close(call.path)

/** A person's click or key on a tab: `file/open` at the lines the tab last highlighted. */
export const openTab = (path: string) =>
  Effect.gen(function* () {
    const store = yield* FilesStore
    const here = yield* (yield* FilesPage).here
    const row = Option.isNone(here) ? undefined : tabsAt(yield* store.tabs.toArray, here.value).find((r) => r.path === path)
    yield* Effect.ignore(
      (yield* FlowDispatch).dispatch("file/open", { path, ...(row?.lines == null ? {} : { lines: row.lines }) }, {
        door: "button",
      }),
    )
  })

/** A person's close button or key on a tab: `file/close`. */
export const closeTab = (path: string) =>
  Effect.flatMap(FlowDispatch, (dispatch) => Effect.ignore(dispatch.dispatch("file/close", { path }, { door: "button" })))
