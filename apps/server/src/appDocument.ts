import { AVAILABLE_REPOS, COMING_SOON_REPOS } from "./publicRepoCatalog"

/*
 * The app document. The smithers.sh Astro build (apps/site) prerenders the
 * product app once per catalog repository at /<owner>/<name>/index.html and
 * mounts it as a React island, and this Worker serves that build's dist as
 * its assets. The document is fetched from the assets layer by its canonical
 * path with a trailing slash: the assets layer answers `/owner/name` with a
 * 307 to `/owner/name/` when only `index.html` exists under it, and a
 * redirect is not the document.
 *
 * The build stamp (`<meta name="smithers-build-sha">`) lives on this document
 * and not on the site's landing page, so scripts/canary/build-probe.ts reads
 * the HTML from here too.
 */

/** The prerendered app page for one catalog repository name, as the assets layer stores it. */
export const appDocumentPath = (repoName: string): string => `/${repoName}/`

/**
 * The document a frame path reloads into. Every prerendered app page is the
 * same shell (only the title differs), so the first catalog repository's page
 * stands in for a path that names no repository.
 */
export const DEFAULT_APP_DOCUMENT_PATH = appDocumentPath(AVAILABLE_REPOS[0].name)

/**
 * The app's frame history writes `/w/<workspace>/b/<branch>/f/<frame>`
 * (apps/app/src/mainview/runtime/FrameHistory.ts). A reload or a deep link at
 * such a path is the app, and the assets layer has no file for it.
 */
export const FRAME_PATH_PREFIX = "/w/"

export const isFramePath = (pathname: string): boolean =>
  /^\/w\/[^/]+\/b\/[^/]+\/f\/[^/]+\/?$/.test(pathname)

/** The roster entry a path names, by GitHub's case-insensitive rule; `/owner/name/` is the same page. */
const rosterEntry = <Repo extends { readonly name: string }>(roster: ReadonlyArray<Repo>, pathname: string): Repo | undefined => {
  const name = pathname.toLowerCase().replace(/\/$/, "")
  return roster.find((entry) => `/${entry.name.toLowerCase()}` === name)
}

/** The canonical app page for a routed path, or undefined when the path names no catalog repository. */
export const catalogDocumentPath = (pathname: string): string | undefined => {
  const repo = rosterEntry(AVAILABLE_REPOS, pathname)
  return repo === undefined ? undefined : appDocumentPath(repo.name)
}

/**
 * The prerendered coming-soon page for a path that names a COMING_SOON_REPOS
 * entry, or undefined. The same build prerenders it at /<owner>/<name>/
 * (apps/site src/pages/[owner]/[repo].astro) as a page of the site, not the
 * app: it carries no build stamp and no isolation headers. The Worker runs
 * first for its owners (COMING_SOON_WORKER_FIRST), so a variant the assets
 * have no file for (the name in another case, no trailing slash) reaches this
 * branch and serves the canonical page instead of the 404 page.
 */
export const comingSoonDocumentPath = (pathname: string): string | undefined => {
  const repo = rosterEntry(COMING_SOON_REPOS, pathname)
  return repo === undefined ? undefined : appDocumentPath(repo.name)
}

/**
 * The `run_worker_first` entries wrangler.jsonc must carry for the coming-soon
 * pages: one per owner in the owner's GitHub case and one in lowercase when
 * they differ. wrangler matches the patterns case-sensitively (live,
 * /SmithersAI/Smithers is the 404 page while /smithersai/Smithers is the app),
 * and with the 2026-08-01 compatibility date a browser navigation to a path
 * the build has no file for is the assets layer's 404 page before the Worker
 * runs; the repository segment and the trailing slash are the Worker's to
 * normalise once the owner is listed. An owner typed in a third case
 * (/Effect-Ts/effect) is still the 404 page.
 */
export const COMING_SOON_WORKER_FIRST: ReadonlyArray<string> = [
  ...new Set(COMING_SOON_REPOS.flatMap((repo) => {
    const owner = repo.name.slice(0, repo.name.indexOf("/"))
    return [`/${owner}/*`, `/${owner.toLowerCase()}/*`]
  }))
]
