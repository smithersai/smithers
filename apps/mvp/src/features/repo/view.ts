import { CAPACITY_COPY, CLONING, COULDNT_LOAD, FAILURE_COPY, formatBytes, githubRawUrl, MEMBERS_CLONE, NOT_FOUND, NOT_CLONED, rawRoute, SIGN_IN_TO_CLONE } from "./contract"
import { Option } from "effect"
import { folderOf } from "../generated/contract"
import { generatedFiles } from "../generated/contribution"
import { parseManifest } from "../generated/detect"
import { type GeneratedLinks, generatedLinksOf } from "../generated/view"
import { hrefFor } from "./paths"
import type { AboutRow, BlobRow, CloneRow, RefsRow, TreeRow, ViewRow } from "./rows"
import type { About, Ref, Repository } from "./schema"

// What the view shows, from the rows the queries read (decision 0006 §2): pure functions, so a component only renders
// their result and a TUI can show the same.

/** A resolved repository whose refs do not contain the requested revision. */
export const missingRefOf = (view: ViewRow): boolean =>
  view.missing && view.ref !== null && view.refsKey !== null

/** A missing file of a known revision has a path-specific way back to Code. */
export const missingFileOf = (kind: "tree" | "blob", row: BlobRow | undefined): boolean =>
  kind === "blob" && row?.state === "failed" && row.message === NOT_FOUND

/** A public root whose About retries ended must show the refusal, not an absent clone. */
export const aboutFailed = (row: AboutRow | undefined, header: Header, root: boolean): boolean =>
  (header.kind === "clone" || header.kind === "sign_in" || header.kind === "unavailable") && root && row?.state === "failed"

/** A file list as `RepoView` takes it. */
export type TreeProps =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly paths: ReadonlyArray<string>; readonly truncated: boolean }
  | { readonly state: "failed"; readonly message: string }

/** A file as `RepoView` takes it. */
export type FileProps =
  | { readonly state: "loading" }
  | { readonly state: "text"; readonly contents: string; readonly size: number }
  | { readonly state: "binary" | "too-large"; readonly size: number }
  | { readonly state: "failed"; readonly message: string }

/** Branches and tags as the picker takes them. */
export type RefsProps =
  | { readonly state: "loading" }
  | {
    readonly state: "ready"
    readonly branches: ReadonlyArray<Ref>
    readonly tags: ReadonlyArray<Ref>
    readonly truncated: boolean
  }
  | { readonly state: "failed"; readonly message: string }

/** A branches and tags row as the picker shows it; no row yet is loading. */
export const refsProps = (row: RefsRow | undefined): RefsProps => {
  if (row === undefined || row.state === "loading") return { state: "loading" }
  if (row.state === "failed") return { state: "failed", message: row.message ?? "" }
  return { state: "ready", branches: row.branches, tags: row.tags, truncated: row.truncated }
}

/** What the picker's button says for `revision`: a branch or tag name, or a commit's short SHA. */
export const revisionLabel = (revision: string): string =>
  /^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 7) : revision

/**
 * A file's toolbar links: `raw`, the bytes RepoApi serves as a page shows them, or GitHub's for a file over its limit;
 * `download`, the same bytes saved under the file's name; and whether its text can be copied. None until it loads.
 */
export interface FileLinks {
  readonly raw?: string
  readonly download?: { readonly href: string; readonly name: string }
  readonly copyContents: boolean
}

/** The toolbar links of the file at `view`, as loaded in `file`. */
export const fileLinksOf = (
  view: { readonly owner: string; readonly name: string; readonly sha: string | null; readonly path: string },
  file: BlobRow | undefined,
): FileLinks => {
  if (view.sha === null || file === undefined || file.state === "loading" || file.state === "failed") {
    return { copyContents: false }
  }
  if (file.state === "too-large") return {
    raw: githubRawUrl(view.owner, view.name, view.sha, view.path),
    download: { href: `${rawRoute(view.owner, view.name, view.sha, view.path)}?download=1`, name: view.path.split("/").at(-1)! },
    copyContents: false,
  }
  const raw = rawRoute(view.owner, view.name, view.sha, view.path)
  return { raw, download: { href: raw, name: view.path.split("/").at(-1)! }, copyContents: file.state === "text" }
}

/** A file list row as the view shows it; no row yet is loading. */
export const treeProps = (row: TreeRow | undefined): TreeProps => {
  if (row === undefined || row.state === "loading") return { state: "loading" }
  if (row.state === "failed") return { state: "failed", message: row.message ?? "" }
  return { state: "ready", paths: row.paths, truncated: row.truncated }
}

/** A file row as the view shows it; no row yet is loading. */
export const fileProps = (row: BlobRow | undefined): FileProps => {
  if (row === undefined || row.state === "loading") return { state: "loading" }
  if (row.state === "failed") return { state: "failed", message: row.message ?? "" }
  if (row.state === "text") return { state: "text", contents: row.contents ?? "", size: row.size ?? 0 }
  return { state: row.state, size: row.size ?? 0 }
}

/**
 * What the repository's header shows besides its name:
 * - `clone`: the Clone button; `sign_in`: the sign-in link in its place;
 * - `cloning`: nothing, from Clone pressed until the clone settles: the person's feed follows it;
 * - `refused`: why the clone failed or was refused; Try again unless `retry` is false;
 * - `ready`: nothing.
 */
export type Header =
  | { readonly kind: "unknown" | "cloning" | "ready" | "missing" | "unavailable" }
  | { readonly kind: "clone"; readonly status?: string }
  | { readonly kind: "sign_in"; readonly text: string; readonly status?: string }
  | { readonly kind: "refused"; readonly text: string; readonly retry?: boolean }

export { formatBytes } from "./contract"

/** A timestamp as Postgres prints it (`2026-10-20 15:40:00+00`), or ISO, in epoch milliseconds. */
export const parseTimestamp = (value: string): number =>
  Date.parse(value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"))

/** A refused clone's reason, with its size or the time GitHub gives the size again. */
export const capacityText = (repository: Repository): string => {
  const reason = repository.capacity ?? "paused"
  if (reason === "too_large" && repository.storedBytes !== null) {
    return `${CAPACITY_COPY.too_large} · ${formatBytes(repository.storedBytes)}`
  }
  if (reason === "size_unknown" && repository.retryAt !== null) {
    const at = new Date(parseTimestamp(repository.retryAt))
    return `${CAPACITY_COPY.size_unknown} ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
  }
  return CAPACITY_COPY[reason]
}

/**
 * The header for `repository` as Postgres has it, this tab's own clone request, and whether someone is signed in
 * (`null` when sign-in hasn't said). This tab's request wins until Electric delivers what it did. A repository the
 * device doesn't have is `unknown`, offering nothing, until the repositories' shape has `answered` once: until then
 * the device can't tell a repository nobody cloned from one whose row is still on its way. About's missing result
 * removes clone and repository navigation actions when no repository row or clone request exists.
 */
export const headerOf = (
  repository: Repository | undefined,
  clone: CloneRow | undefined,
  signedIn: boolean | null,
  answered = true,
  about?: AboutRow,
): Header => {
  if (clone !== undefined) {
    switch (clone.status) {
      case "requesting":
        return { kind: "cloning" }
      case "sign_in":
        return { kind: "sign_in", text: SIGN_IN_TO_CLONE }
      case "forbidden":
        // Members only, with Try again: installing the App or a role given there lets the next try in (ruling AUTH-8).
        return { kind: "refused", text: MEMBERS_CLONE }
      case "limit":
        return { kind: "refused", text: "Clone limit reached." }
      case "failed":
        return { kind: "refused", text: FAILURE_COPY.unavailable }
    }
  }
  if (repository === undefined && about?.state === "missing") {
    return { kind: "missing" }
  }
  if (repository === undefined && about?.state === "failed") return { kind: "unavailable" }
  if (repository === undefined && !answered) return { kind: "unknown" }
  if (repository === undefined) return signedIn === false ? { kind: "sign_in", text: SIGN_IN_TO_CLONE } : { kind: "clone" }
  switch (repository.status) {
    case "cloning":
      return { kind: "cloning" }
    case "ready":
      return { kind: "ready" }
    case "failed":
      return { kind: "refused", text: FAILURE_COPY[repository.failure ?? "unavailable"] }
    case "capacity":
      return { kind: "refused", text: capacityText(repository) }
  }
}

/**
 * What the Code view says in place of the files while the repository isn't ready, from its `header`, so the view is
 * never a blank page: `Cloning` while it clones, else `Not cloned` beside the header's Clone, sign-in link or reason.
 * Nothing while the device can't tell yet (`unknown`) or once it is `ready`.
 */
export const codeEmptyOf = (header: Header): string | undefined =>
  header.kind === "unknown" || header.kind === "ready" ? undefined : header.kind === "cloning" ? CLONING : header.kind === "missing" ? NOT_FOUND : header.kind === "unavailable" ? COULDNT_LOAD : NOT_CLONED

/** The head commit's row: its message's first line, its author, its short SHA and when it was made. */
export interface Commit {
  readonly message: string
  readonly author: string
  readonly shortSha: string
  readonly at: number
}

/**
 * The head commit of a ready repository, when the view is at it (`sha`, absent for any); `undefined` before Settle
 * wrote it, or at another commit, whose details the view doesn't have.
 */
export const commitOf = (repository: Repository | undefined, sha?: string | null): Commit | undefined => {
  if (repository?.headSha == null || repository.headAt === null) return undefined
  if (sha !== undefined && sha !== repository.headSha) return undefined
  return {
    message: (repository.headMessage ?? "").split("\n", 1)[0]!,
    author: repository.headAuthor ?? "",
    shortSha: repository.headSha.slice(0, 7),
    at: parseTimestamp(repository.headAt),
  }
}

/** Whether the view is a repository's top level: its home, or the root of a branch, tag or commit. */
export const atRoot = (view: { readonly kind: "tree" | "blob"; readonly path: string }): boolean =>
  view.kind === "tree" && view.path === ""

/** The about answer an about row holds, once it is ready. */
export const aboutOf = (row: AboutRow | undefined): About | undefined =>
  row?.state === "ready" && row.about !== null ? row.about : undefined

/** Epoch milliseconds of an ISO time, or `undefined` for none or one that doesn't read. */
const instant = (iso: string | null | undefined): number | undefined => {
  const at = iso === null || iso === undefined ? Number.NaN : Date.parse(iso)
  return Number.isNaN(at) ? undefined : at
}

/** GitHub's page of a repository, a release or a person. */
const githubPage = (path: string) => `https://github.com/${path}`

/**
 * The about panel's props for `RepoAbout` (`@smthrs/ui`) from what GitHub says: times in epoch ms, and links to
 * GitHub's own pages for the release and each contributor. `loading` while the answer is on its way.
 */
export const aboutProps = (row: AboutRow | undefined) => {
  const about = aboutOf(row)
  if (about === undefined) return { loading: row === undefined || row.state === "loading" }
  return {
    loading: false,
    description: about.description,
    homepage: about.homepage,
    topics: about.topics,
    stars: about.stars,
    watchers: about.watchers,
    forks: about.forks,
    license: about.license,
    release: about.release === null ? null : {
      tag: about.release.tag,
      name: about.release.name,
      publishedAt: instant(about.release.publishedAt) ?? null,
      href: githubPage(`${about.name}/releases/tag/${encodeURIComponent(about.release.tag)}`),
    },
    releases: about.releases,
    contributors: about.contributors.map((person) => ({
      login: person.login,
      avatarUrl: person.avatarUrl,
      href: githubPage(encodeURIComponent(person.login)),
    })),
    contributorCount: about.contributorCount,
    languages: about.languages,
  }
}

/**
 * The top level GitHub lists before a clone, as `RepoView` takes a file list: the files as paths and the folders as
 * directories known without their files. `undefined` until GitHub's answer has one.
 */
export const previewTreeOf = (about: About | undefined) => {
  if (about?.root == null) return undefined
  return {
    state: "ready" as const,
    paths: about.root.filter((entry) => entry.kind === "file").map((entry) => entry.name),
    directories: about.root.filter((entry) => entry.kind === "dir").map((entry) => entry.name),
    truncated: false,
  }
}

/** GitHub's README before a clone, as `RepoView` takes a directory's README; `undefined` without one. */
export const previewReadmeOf = (about: About | undefined) =>
  about?.readme == null ? undefined : {
    path: about.readme.path,
    file: { state: "text" as const, contents: about.readme.text, size: new TextEncoder().encode(about.readme.text).length },
  }

/** The newest commit GitHub names, as the commit row shows it; `undefined` without one. */
export const previewCommitOf = (about: About | undefined): Commit | undefined => {
  const at = instant(about?.head?.at)
  if (about?.head == null || at === undefined) return undefined
  return {
    message: about.head.message.split("\n", 1)[0]!,
    author: about.head.author,
    shortSha: about.head.sha.slice(0, 7),
    at,
  }
}

/** How many branches, tags and commits the page shows beside the picker; each `undefined` when nothing says. */
export interface Counts {
  readonly branches?: number
  readonly tags?: number
  readonly commits?: number
}

/**
 * The counts beside the picker: the branches and tags of the repository's own sync once its refs loaded (what the
 * picker lists), else what GitHub says; the commits only GitHub counts.
 */
export const countsOf = (refs: RefsRow | undefined, about: About | undefined): Counts => {
  const synced = refs?.state === "ready" && !refs.truncated ? refs : undefined
  const branches = synced?.branches.length ?? about?.branches ?? undefined
  const tags = synced?.tags.length ?? about?.tags ?? undefined
  const commits = about?.commits ?? undefined
  return {
    ...(branches === undefined || branches === null ? {} : { branches }),
    ...(tags === undefined || tags === null ? {} : { tags }),
    ...(commits === undefined || commits === null ? {} : { commits }),
  }
}

/** A count and its noun: `1 Branch`, `3 Branches`, `0 Tags`. */
export const countLabel = (count: number, one: string, many: string): string =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`

/**
 * The quiet note on a cloned repository whose copy storage may reclaim: until the Smithers GitHub App is installed on
 * it. `installUrl` is where Install goes. `undefined` for any other repository.
 */
export const reclaimNoteOf = (repository: Repository | undefined, about: About | undefined) =>
  repository?.status === "ready" && repository.reclaimable === true ? { installUrl: about?.installUrl ?? null } : undefined

/** A repository as the page links into it: its owner, name and default branch. */
export interface Shown {
  readonly owner: string
  readonly name: string
  readonly defaultBranch: string | null
}

/** The view as its live query reads it: the view row, its repository's synced row, this tab's clone and About. */
export interface ViewState {
  readonly view: ViewRow
  readonly repository?: Repository | undefined
  readonly clone?: CloneRow | undefined
  readonly about?: AboutRow | undefined
}

/**
 * The repository whose files the page shows: its synced row once ready; before Electric delivers that row, the one the
 * view's load found ready through RepoApi's refs (the view has its commit); else none, and the page says why not.
 */
export const shownOf = (repository: Repository | undefined, view: ViewRow): Shown | undefined =>
  repository?.status === "ready"
    ? repository
    : view.sha === null
    ? undefined
    : { owner: view.owner, name: view.name, defaultBranch: view.defaultBranch }

/**
 * What the repository page shows (RepoPage):
 * - `loading`: a skeleton in the files' place, while the device can't tell yet;
 * - `missing`: Not found; `failure`: why the location couldn't resolve;
 * - `retry`: a public root whose About read ended refused, with Try again;
 * - `preview-loading`, `preview`: the top level before a clone, as GitHub has it, loading or with its `about`;
 * - `empty`: Not cloned or Cloning in the files' place;
 * - `files`: the files of `repository` (`shownOf`).
 */
export type Page =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "preview-loading" }
  | { readonly kind: "failure"; readonly text: string }
  | { readonly kind: "retry"; readonly text: string }
  | { readonly kind: "empty"; readonly text: string }
  | { readonly kind: "preview"; readonly about: About }
  | { readonly kind: "files"; readonly repository: Shown }

/** What the page shows for the view as its live query reads it; `undefined` before the query's first read. */
export const pageOf = (current: ViewState | undefined): Page => {
  if (current === undefined) return { kind: "loading" }
  const { view, repository, about: aboutRow } = current
  const shown = shownOf(repository, view)
  const root = atRoot(view)
  // GitHub has no such public repository, and no copy of one is here: there is nothing to show or clone.
  if (view.missing || (shown === undefined && aboutRow?.state === "missing")) return { kind: "missing" }
  if (view.failure !== null) return { kind: "failure", text: view.failure }
  if (shown !== undefined) return { kind: "files", repository: shown }
  const header = headerOf(repository, current.clone, view.signedIn, view.answered, aboutRow)
  if (aboutFailed(aboutRow, header, root)) return { kind: "retry", text: aboutRow?.message ?? COULDNT_LOAD }
  if (root && (aboutRow === undefined || aboutRow.state === "loading")) return { kind: "preview-loading" }
  const about = aboutOf(aboutRow)
  if (root && about?.root != null) return { kind: "preview", about }
  const empty = codeEmptyOf(header)
  return empty === undefined ? { kind: "loading" } : { kind: "empty", text: empty }
}

/**
 * The head commit's row for the view at `sha`: the synced row's (`commitOf`), else GitHub's newest commit when it is
 * that very commit, so a page whose repository Electric hasn't delivered yet still says who made it and when.
 */
export const headCommitOf = (repository: Repository | undefined, sha: string | null, about: About | undefined) =>
  commitOf(repository, sha) ?? (sha !== null && about?.head?.sha === sha ? previewCommitOf(about) : undefined)

/**
 * The Generated mark's links for the file at `path`, read as `contents` (the view's file, or the branch's working copy
 * in its editor), from the generated-files manifest nearest it at the view's commit (`manifestPath`, as `manifest`) and
 * the file list there of the repository the page shows (`shownOf`); `undefined` for a file a person writes. Links go to
 * the view's revision.
 */
export const generatedLinksFor = (
  view: {
    readonly owner: string
    readonly name: string
    readonly revision: string | null
    readonly manifestPath: string | null
  },
  repository: Shown | undefined,
  path: string,
  contents: string | undefined,
  manifest: BlobRow | undefined,
  tree: TreeRow | undefined,
): GeneratedLinks | undefined => {
  const folder = view.manifestPath === null ? "" : folderOf(view.manifestPath)
  // With no manifest near the view, only a header marker marks a file.
  const inFolder = view.manifestPath !== null && (folder === "" || path.startsWith(`${folder}/`))
  const generated = generatedFiles.detect(
    folder === "" ? path : path.slice(folder.length + 1),
    contents,
    inFolder ? parseManifest(manifest?.state === "text" ? manifest.contents ?? undefined : undefined) : Option.none(),
  )
  if (generated === undefined || repository === undefined) return undefined
  const revision = view.revision ?? repository.defaultBranch ?? ""
  const paths = new Set(tree?.state === "ready" ? tree.paths : [])
  return generatedLinksOf(
    generated,
    (file) => hrefFor(repository, revision, { kind: "blob", path: file }),
    (file) => paths.has(file),
    folder,
  )
}

/** Whether a directory URL names a file the loaded tree actually contains. */
export const directoryFileOf = (kind: "tree" | "blob", path: string, tree: TreeRow | undefined): boolean =>
  kind === "tree" && path !== "" && tree?.state === "ready" && tree.paths.includes(path)
