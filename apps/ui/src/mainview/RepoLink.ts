import { AUTH_SIGNED_IN_PARAM } from "@smthrs/rpc/AgentApiRoutes"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import type { AppController } from "./state/AppController"
import { repoTreeRowId, sharedCopyIdOf } from "./state/AppState"

/*
 * A repository's app lives at `/owner/name` (https://smithers.sh/smithersai/smithers).
 * The landing page's older "Open in Smithers" link lands on `/?repo=owner/name`.
 * The path wins; the parameter is read only at `/`. The name is honoured only
 * when the public catalog (GET /api/public/repos, the same list the landing
 * page renders) carries it: the catalog row enters the repositories collection
 * and becomes the active selection, so the first turn is about that
 * repository. The path stays in the address bar, so a reload reselects; the
 * parameter is removed from the URL either way, so a reload does not.
 */

export const REPO_PARAM = "repo"
export const PUBLIC_REPOS_PATH = "/api/public/repos"

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/

/**
 * The `owner/name` a `/owner/name` path names (exactly two segments), or null
 * for any other path. A trailing slash is the same repository: a prerendered
 * `/owner/name/index.html` is served at `/owner/name/` by hosts that do not
 * strip it.
 */
export const pathRepo = (pathname: string): string | null => {
  const match = /^\/([^/]+)\/([^/]+)\/?$/.exec(pathname)
  if (match === null) return null
  const value = `${match[1]}/${match[2]}`
  return REPO_NAME.test(value) ? value : null
}

/** The `owner/name` the `repo` parameter names, or null when absent or not a repository name. */
export const paramRepo = (search: string): string | null => {
  const value = new URLSearchParams(search).get(REPO_PARAM)?.trim() ?? ""
  return REPO_NAME.test(value) ? value : null
}

/** The `owner/name` the URL asks for: the `/owner/name` path first, else the `repo` parameter at `/`. */
export const requestedRepo = (location: Pick<Location, "pathname" | "search">): string | null =>
  pathRepo(location.pathname) ?? (location.pathname === "/" ? paramRepo(location.search) : null)

export interface CatalogRepository {
  /** `owner/name`, in the catalog's spelling. */
  readonly id: string
  readonly org: string
  readonly name: string
  /** The catalog's curated one-sentence explanation, when it carries one. */
  readonly summary?: string
}

/** The catalog entry the request names (GitHub names are case-insensitive); the catalog's spelling wins. */
export const catalogRepository = (catalog: unknown, requested: string): CatalogRepository | null => {
  if (typeof catalog !== "object" || catalog === null) return null
  const repos: unknown = (catalog as { readonly repos?: unknown }).repos
  if (!Array.isArray(repos)) return null
  const wanted = requested.toLowerCase()
  for (const entry of repos) {
    const name: unknown = typeof entry === "object" && entry !== null ? (entry as { readonly name?: unknown }).name : undefined
    if (typeof name !== "string" || !REPO_NAME.test(name) || name.toLowerCase() !== wanted) continue
    const slash = name.indexOf("/")
    const summary: unknown = (entry as { readonly summary?: unknown }).summary
    return {
      id: name,
      org: name.slice(0, slash),
      name: name.slice(slash + 1),
      ...(typeof summary === "string" && summary.trim() !== "" ? { summary: summary.trim() } : {})
    }
  }
  return null
}

/*
 * The server drops a longer return path (apps/server validReturnTo), so the
 * client sends the bare page rather than lose the whole return.
 */
const RETURN_TO_MAX_BYTES = 512

/**
 * The page a sign-in started from a repository path returns to: the path and
 * its query, minus the auth markers a previous return spent (`signed-in`,
 * `auth`), so they are never replayed. Null anywhere but `/owner/name`: the
 * landing page is where the callback lands on its own.
 */
export const signInReturnTo = (location: Pick<Location, "pathname" | "search">): string | null => {
  if (pathRepo(location.pathname) === null) return null
  const params = new URLSearchParams(location.search)
  params.delete(AUTH_SIGNED_IN_PARAM)
  params.delete("auth")
  const search = params.toString()
  const withSearch = `${location.pathname}${search === "" ? "" : `?${search}`}`
  return new TextEncoder().encode(withSearch).byteLength > RETURN_TO_MAX_BYTES ? location.pathname : withSearch
}

/** The same location without the repo parameter; other parameters and the fragment stay. */
export const withoutRepoParam = (location: Pick<Location, "pathname" | "search" | "hash">): string => {
  const params = new URLSearchParams(location.search)
  params.delete(REPO_PARAM)
  const search = params.toString()
  return `${location.pathname}${search === "" ? "" : `?${search}`}${location.hash}`
}

/** Whether the transcript already opens on this repository's welcome card (controller/onboarding.ts). */
const welcomed = (controller: Pick<AppController, "store">, repo: string): boolean => {
  for (const card of controller.store.collections.cards.values()) {
    if (card.kind === "repo-onboarding" && card.payload.stage === "welcome" && card.payload.repo === repo) return true
  }
  return false
}

/**
 * The repository document's default bookmark, read from the public mirror
 * (`GET /api/repos/{o}/{r}`, a public repository read the Worker forwards
 * with no credentials): the bookmark the shared read-only copy tracks. The
 * catalog itself carries no head, so this is the one honest source signed
 * out. Null when the document cannot be read or names no default bookmark:
 * the copy then shows no bookmark, never an invented one.
 */
const defaultBookmarkOf = async (http: FetchLike, repo: string): Promise<string | null> => {
  const [owner = "", name = ""] = repo.split("/")
  try {
    const response = await http(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { headers: { accept: "application/json" } })
    if (!response.ok) return null
    const body: unknown = await response.json()
    const bookmark: unknown = typeof body === "object" && body !== null ? (body as { readonly default_bookmark?: unknown }).default_bookmark : undefined
    return typeof bookmark === "string" && bookmark !== "" ? bookmark : null
  } catch {
    return null
  }
}

/**
 * Select the requested repository when the public catalog carries it. The
 * catalog row joins the repositories collection beside whatever the cloud
 * inventory already loaded, then `repo.select` makes it the active one, and
 * the welcome (`repo.welcome`) opens the transcript unless a reload finds it
 * already there. The repository's shared read-only copy (WorkspaceViews.ts)
 * opens its root in the sidebar on this first paint, and the mirror's
 * default bookmark lands on the row so the copy names it. Returns the
 * refusal when the request could not be honoured.
 */
export const openRequestedRepo = async (
  controller: Pick<AppController, "store" | "selectRepo" | "runCommand">,
  http: FetchLike,
  requested: string
): Promise<string | void> => {
  let catalog: unknown
  try {
    const response = await http(PUBLIC_REPOS_PATH, { headers: { accept: "application/json" } })
    if (!response.ok) return `The public repository catalog answered HTTP ${response.status}.`
    catalog = await response.json()
  } catch (cause) {
    return `The public repository catalog could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
  }
  const repository = catalogRepository(catalog, requested)
  if (repository === null) return `${requested} is not in the public repository catalog.`
  const { repositories } = controller.store.collections
  if (repositories.get(repository.id) === undefined) {
    controller.store.dispatch({
      type: "repository.upserted",
      actor: "system",
      /*
       * The catalog carries no owner kind and no head. "user" is the
       * conservative reading: the one consumer (the org changesets read)
       * treats it as "no org changesets", never as a fabricated org.
       * `catalog` records where the row came from: readable signed out.
       */
      repository: { ...repository, ownerKind: "user" as const, head: null, catalog: true }
    })
  }
  const refusal = await controller.selectRepo(repository.id)
  if (refusal !== undefined) return refusal
  if (!welcomed(controller, repository.id)) controller.runCommand("repo.welcome")
  /*
   * The shared copy's tree opens once, on the first paint of the catalog
   * repository: `repo.tree <copyId>` through the registry, the same act the
   * caret runs. The tree rows live for this launch only, so a row already
   * there is this launch's own state, and the caret is the visitor's.
   */
  const sharedId = sharedCopyIdOf(repository.id)
  if (
    controller.store.collections.workingCopies.get(sharedId) !== undefined &&
    controller.store.collections.repoTree.get(repoTreeRowId(sharedId, "")) === undefined
  ) {
    controller.runCommand("repo.tree", sharedId)
  }
  const bookmark = await defaultBookmarkOf(http, repository.id)
  const row = controller.store.collections.repositories.get(repository.id)
  if (bookmark === null || row === undefined || row.head !== null) return
  controller.store.dispatch({
    type: "repository.upserted",
    actor: "system",
    repository: { ...row, head: { bookmark, changeId: null, commitId: null } }
  })
}
