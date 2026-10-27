import { type CopyKind, SHA_PATTERN } from "./contract"

// Where things are in a repository and in the app's URLs (decision 0006 §2, Routing). Pure functions: the actions,
// the queries and the views share them.

/** The key of a repository's file list at `sha`. */
export const treeKey = (id: string, sha: string): string => `${id}@${sha}`

/** The key of a file at `sha`. */
export const blobKey = (id: string, sha: string, path: string): string => `${id}@${sha}:${path}`

/**
 * The key of a repository's branches and tags as of the sync whose default branch is at `headSha` and the last ref
 * change after it (`refsChangedAt`, the row's): a ref that moves without the head moving reads them again.
 */
export const refsKey = (id: string, headSha: string, refsChangedAt?: string | null): string =>
  `${id}@${headSha}@${refsChangedAt ?? ""}`

/**
 * Whether `path` is a Markdown file the app edits as a document: in the live Markdown editor, in place on its page for
 * a person who may write the branch (docs/features/repo.md#the-browser).
 */
export const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path)

/** The README of directory `dir` (`""` is the root): its direct entry named `README.md`, in any case. */
export const readmeOf = (paths: ReadonlyArray<string>, dir: string): string | undefined => {
  const prefix = dir === "" ? "" : `${dir}/`
  return paths.find((path) => path.startsWith(prefix) && path.slice(prefix.length).toLowerCase() === "readme.md")
}

/** What a URL's ref and path name in a repository: the revision links keep, the commit, and the path. */
export interface Resolved {
  readonly revision: string
  readonly sha: string
  readonly path: string
}

/** A branch or tag as ref resolution matches it: its name and the commit it names. */
export interface NamedRef {
  readonly name: string
  readonly sha: string
}

/** A repository's branches and tags, once the device has them. */
export interface KnownRefs {
  readonly branches: ReadonlyArray<NamedRef>
  readonly tags: ReadonlyArray<NamedRef>
}

/**
 * Resolves a URL's `ref` (absent at `/$owner/$repo`) and the path after it against a ready repository, as GitHub does:
 * a 40-hex SHA reads at itself, a branch or tag at its commit, the default branch at its head. A name with a `/`
 * arrives split across the ref and the path, so the two are matched together, and the longest name that leads them
 * wins; a branch wins over a tag of the same name. Without `refs` only the default branch and SHAs resolve. Anything
 * else names nothing the view can read: `undefined`.
 */
export const resolveRef = (
  repository: { readonly defaultBranch: string | null; readonly headSha: string | null },
  ref: string | null,
  splat: string,
  refs?: KnownRefs,
): Resolved | undefined => {
  const { defaultBranch, headSha } = repository
  if (ref !== null && SHA_PATTERN.test(ref)) return { revision: ref, sha: ref, path: splat }
  if (defaultBranch === null || headSha === null) return undefined
  if (ref === null) return { revision: defaultBranch, sha: headSha, path: splat }
  const joined = splat === "" ? ref : `${ref}/${splat}`
  const named = [{ name: defaultBranch, sha: headSha }, ...(refs?.branches ?? []), ...(refs?.tags ?? [])]
  const leading = named.filter(({ name }) => joined === name || joined.startsWith(`${name}/`))
  const best = leading.reduce<NamedRef | undefined>(
    (longest, candidate) => (longest === undefined || candidate.name.length > longest.name.length ? candidate : longest),
    undefined,
  )
  if (best === undefined) return undefined
  return { revision: best.name, sha: best.sha, path: joined === best.name ? "" : joined.slice(best.name.length + 1) }
}

/** A line anchor: `?L=<n>` or `?L=<a>-<b>`. The router may hand over `3` as a number. Anything else anchors nothing. */
export const parseLines = (value: unknown): { readonly line: number | null; readonly lineEnd: number | null } => {
  const match = /^([1-9]\d{0,8})(?:-([1-9]\d{0,8}))?$/.exec(String(value ?? ""))
  if (match === null) return { line: null, lineEnd: null }
  const line = Number(match[1])
  const end = match[2] === undefined ? line : Number(match[2])
  return end > line ? { line, lineEnd: end } : { line, lineEnd: null }
}

/** GitHub line fragments, including ranges; unrelated fragments select nothing. */
export const parseLineHash = (hash: string): ReturnType<typeof parseLines> => {
  const match = /^#?L([1-9]\d{0,8})(?:-L([1-9]\d{0,8}))?$/.exec(hash)
  return match === null ? parseLines(undefined) : parseLines(`${match[1]}${match[2] === undefined ? "" : `-${match[2]}`}`)
}

/** A path as a URL writes it: each segment encoded, the slashes kept. */
export const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/")

/** A view location, as `RepoView` names it. */
export interface Location {
  readonly kind: "tree" | "blob"
  readonly path: string
  readonly line?: number | undefined
  readonly lineEnd?: number | undefined
}

/**
 * The app's URL of `location` in `owner/name` at `revision`, as GitHub writes it: `/$owner/$repo` for the root at the
 * default branch, else `/$owner/$repo/{tree,blob}/<revision>/<path>`, a branch's `/` kept, a file's line anchor in `?L=`.
 */
export const hrefFor = (
  repository: { readonly owner: string; readonly name: string; readonly defaultBranch: string | null },
  revision: string,
  location: Location,
): string => {
  const base = `/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`
  if (location.kind === "tree" && location.path === "" && revision === repository.defaultBranch) return base
  const at = `${base}/${location.kind}/${encodePath(revision)}${
    location.path === "" ? "" : `/${encodePath(location.path)}`
  }`
  if (location.kind !== "blob" || location.line === undefined) return at
  const end = location.lineEnd !== undefined && location.lineEnd > location.line ? `-${location.lineEnd}` : ""
  return `${at}?L=${location.line}${end}`
}

/**
 * The branch workspace's live editor of file `path` at `revision` (docs/features/coedit.md#files): its directory's page
 * with `?edit=` naming the file, JSON-quoted as the router reads a search value, so a path that reads as a number stays
 * a path.
 */
export const editHrefFor = (repository: { readonly owner: string; readonly name: string }, revision: string, path: string) => {
  const directory = path.split("/").slice(0, -1).join("/")
  const at = `/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tree/${encodePath(revision)}`
  return `${at}${directory === "" ? "" : `/${encodePath(directory)}`}?edit=${encodeURIComponent(JSON.stringify(path))}`
}

/**
 * A link in the repository view at `revision`: with `editFiles`, in a branch's workspace for someone who may edit it, a
 * file opens in the live editor (`editHrefFor`), except a Markdown file, whose own page edits it in place; anything
 * else is its page (`hrefFor`).
 */
export const viewHrefFor = (
  repository: { readonly owner: string; readonly name: string; readonly defaultBranch: string | null },
  revision: string,
  location: Location,
  editFiles: boolean,
): string =>
  editFiles && location.kind === "blob" && !isMarkdownPath(location.path)
    ? editHrefFor(repository, revision, location.path)
    : hrefFor(repository, revision, location)

/** What a route opens: the repository, a directory or a file, the URL's ref and path, and the file's line anchor. */
export interface Target {
  readonly owner: string
  readonly name: string
  readonly kind: "tree" | "blob"
  readonly ref: string | null
  readonly path: string
  readonly line: number | null
  readonly lineEnd: number | null
}

/** A route's params and search as the router hands them over. */
export interface RouteParams {
  readonly owner?: string | undefined
  readonly repo?: string | undefined
  readonly ref?: string | undefined
  readonly _splat?: string | undefined
}

/**
 * A repository route's search as the router keeps it (src/router.tsx `validateSearch`): only `?L=`, as the router
 * parsed it, which `parseLines` reads; every other parameter is dropped.
 */
export const lineSearch = (search: Record<string, unknown>): { readonly L?: unknown } =>
  search.L === undefined ? {} : { L: search.L }

/** What the route at `/$owner/$repo[/{tree,blob}/$ref/$]` opens. A trailing slash in the path is dropped. */
export const targetOf = (
  kind: "tree" | "blob",
  params: RouteParams,
  search: { readonly L?: unknown },
): Target => ({
  owner: params.owner ?? "",
  name: params.repo ?? "",
  kind,
  ref: params.ref ?? null,
  path: (params._splat ?? "").replace(/\/+$/, ""),
  ...(kind === "blob" ? parseLines(search.L) : { line: null, lineEnd: null }),
})

/** Where the routed view is, as Copy reads it. */
export interface CopySource {
  readonly owner: string
  readonly name: string
  readonly kind: "tree" | "blob"
  readonly path: string
  readonly sha: string | null
  readonly line: number | null
  readonly lineEnd: number | null
}

/**
 * `repo/copy`'s payload for what a Copy button copies from `view`: the clone URL always; the path of anything but the
 * root; a permalink at the view's commit, with its lines; a file's contents at its commit. `undefined` when the view
 * has nothing of that kind yet.
 */
export const copyPayloadOf = (view: CopySource, what: CopyKind) => {
  const repo = `${view.owner}/${view.name}`
  if (what === "clone-url") return { repo, what }
  if (what === "path") return view.path === "" ? undefined : { repo, what, path: view.path }
  if (view.sha === null) return undefined
  if (what === "contents") {
    return view.kind === "blob" && view.path !== "" ? { repo, what, revision: view.sha, path: view.path } : undefined
  }
  return {
    repo,
    what,
    revision: view.sha,
    kind: view.kind,
    ...(view.path === "" ? {} : { path: view.path }),
    ...(view.kind === "blob" && view.line !== null ? { line: view.line } : {}),
    ...(view.kind === "blob" && view.lineEnd !== null ? { lineEnd: view.lineEnd } : {}),
  }
}

/** Keep the full routed suffix, query and fragment while adopting GitHub's authoritative repository name. */
export const canonicalRepoHref = (
  location: { readonly pathname: string; readonly searchStr: string; readonly hash: string },
  requested: { readonly owner: string; readonly repo: string },
  canonical: string | undefined,
  fileAtTree = false,
): string | undefined => {
  const prefix = `/${encodeURIComponent(requested.owner)}/${encodeURIComponent(requested.repo)}`
  const name = canonical?.split("/")
  const nextPrefix = name?.length === 2 ? `/${encodeURIComponent(name[0]!)}/${encodeURIComponent(name[1]!)}` : prefix
  const suffix = location.pathname.slice(prefix.length)
  const nextSuffix = fileAtTree ? suffix.replace(/^\/tree\//, "/blob/") : suffix
  const pathname = `${nextPrefix}${nextSuffix}`
  return pathname === location.pathname ? undefined : `${pathname}${location.searchStr}${location.hash === "" ? "" : `#${location.hash.replace(/^#/, "")}`}`
}
