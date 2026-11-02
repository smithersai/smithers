import { canonicalRepoHref, staysInRepository } from "./features/repo/paths"

// How a route whose page reads its own synced rows enters (the issues and pull requests lists and pages): it opens
// them at once and never waits for the repository's About. A private repository's About is a GitHub read the server
// answers only after about 1.4 s (production, 2026-11-02, `repo.about` stage `graphql`), and waiting for it, then for a
// second role read, held a cold issue page for 2.6 s of its 7.7 s before its shapes were even asked for. The About,
// the home and the canonical-name check run beside the page; a name that isn't the canonical one replaces the location
// once the About says so, as the check before the page did.

/** What a route's `beforeLoad` knows of the load it is part of. */
export interface Load {
  readonly location: { readonly pathname: string; readonly searchStr: string; readonly hash: string }
  /** A link's hover or focus, not a navigation. */
  readonly preload: boolean
  /** Aborted once a newer navigation takes over. */
  readonly abortController: AbortController
}

/** What entering needs of the app: the repository's and home's actions, and the router to replace a location. */
export interface EnterContext {
  /** The path of the page the router shows until this navigation resolves. */
  readonly shownPath: string | undefined
  /** Replaces the location with `href`, once the canonical name is known. */
  readonly replace: (href: string) => unknown
  readonly repo: {
    readonly actions: {
      readonly warmRoute: (kind: "tree", params: { readonly owner: string; readonly repo: string }, search: object) => Promise<unknown>
      readonly openRoute: (kind: "tree", params: { readonly owner: string; readonly repo: string }, search: object) => unknown
      readonly role: (owner: string, name: string, reuse?: boolean) => unknown
      readonly canonicalName: (owner: string, name: string) => Promise<string | undefined>
    }
  }
  readonly home: {
    readonly actions: {
      readonly warm: (owner: string, name: string) => Promise<unknown>
      readonly open: (owner: string, name: string) => unknown
    }
  }
}

/**
 * Enters a synced page of `params`' repository: warms only `warm` (the page's own rows) before opening, and runs the
 * About, the home and the canonical check beside it. A preload warms and stops; a navigation a newer one took over
 * opens nothing and replaces nothing.
 */
export const enterSynced = async (
  context: EnterContext,
  params: { readonly owner: string; readonly repo: string },
  load: Load,
  warm: () => unknown,
  open: () => unknown,
): Promise<void> => {
  const beside = Promise.all([
    context.repo.actions.warmRoute("tree", params, {}),
    context.home.actions.warm(params.owner, params.repo),
    // recorded: repo.about.load and home.answer log their own failures; the page doesn't wait on them.
  ]).catch(() => undefined)
  await warm()
  if (load.preload || load.abortController.signal.aborted) return
  context.repo.actions.openRoute("tree", params, {})
  context.home.actions.open(params.owner, params.repo)
  context.repo.actions.role(params.owner, params.repo, staysInRepository(context.shownPath, params))
  void beside
    .then(() => context.repo.actions.canonicalName(params.owner, params.repo))
    .then((canonical) => {
      if (load.abortController.signal.aborted) return
      const href = canonicalRepoHref(load.location, params, canonical, false)
      if (href !== undefined) context.replace(href)
    })
    // recorded: repo.about.load logs a failed About; with no canonical name the location stands.
    .catch(() => undefined)
  await open()
}
