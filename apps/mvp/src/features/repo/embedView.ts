import { COULDNT_LOAD, NOT_CLONED, NOT_FOUND } from "./contract"
import { encodePath, hrefFor, type Location } from "./paths"
import type { AboutRow, BlobRow, EmbedRow, TreeRow } from "./rows"
import type { Repository } from "./schema"
import { aboutOf, type FileProps, fileProps, previewReadmeOf, previewTreeOf, type TreeProps, treeProps } from "./view"

// What a repository's view in a conversation shows (docs/features/views.md#a-repository-and-its-issues), from its row
// of the embeds query (queries.ts `embedsQuery`), and where its links and Back to chat go. Pure, so the component only
// renders and a TUI could show the same.

/** One row of the embeds query: the view's row, and what the device has of its repository. */
export interface EmbedQueryRow {
  readonly embed: EmbedRow
  readonly repository?: Pick<Repository, "owner" | "name" | "defaultBranch"> | undefined
  readonly about?: AboutRow | undefined
  readonly tree?: TreeRow | undefined
  readonly body?: BlobRow | undefined
}

/** A file list as the embed shows it: the clone's, or before a clone GitHub's top folder with its folders by name. */
export type EmbedTree = TreeProps | NonNullable<ReturnType<typeof previewTreeOf>>

/**
 * What the view shows:
 * - `loading`: nothing known yet; the view's frame with a loading tree;
 * - `empty`: Not found, Not cloned or why it couldn't load, with its Full screen link;
 * - `view`: the repository at `location`, at `revision`, with the file there or the directory's README.
 */
export type EmbedShown =
  | { readonly kind: "loading" }
  | { readonly kind: "empty"; readonly title: string }
  | {
    readonly kind: "view"
    readonly tree: EmbedTree
    readonly location: Location
    readonly revision: string
    readonly defaultBranch: string | null
    readonly file?: FileProps
    readonly readme?: { readonly path: string; readonly file: FileProps }
  }

/** What view `row` shows; no row yet is loading. */
export const embedShown = (row: EmbedQueryRow | undefined): EmbedShown => {
  const embed = row?.embed
  if (embed === undefined || embed.state === "loading") return { kind: "loading" }
  if (embed.state === "missing") return { kind: "empty", title: embed.message ?? NOT_FOUND }
  if (embed.state === "failed") return { kind: "empty", title: embed.message ?? COULDNT_LOAD }
  if (embed.state === "not_cloned") return { kind: "empty", title: NOT_CLONED }
  if (embed.state === "preview") {
    const about = aboutOf(row?.about)
    const tree = previewTreeOf(about)
    if (about === undefined || tree === undefined) return { kind: "empty", title: NOT_CLONED }
    const readme = previewReadmeOf(about)
    return {
      kind: "view",
      tree,
      location: { kind: "tree", path: "" },
      revision: about.defaultBranch,
      defaultBranch: about.defaultBranch,
      ...(readme === undefined ? {} : { readme }),
    }
  }
  const location: Location = { kind: embed.kind, path: embed.path }
  const body = fileProps(row?.body)
  return {
    kind: "view",
    tree: treeProps(row?.tree),
    location,
    revision: embed.revision ?? "",
    defaultBranch: row?.repository?.defaultBranch ?? null,
    ...(embed.kind === "blob"
      ? { file: body }
      : embed.bodyPath === null
      ? {}
      : { readme: { path: embed.bodyPath, file: body } }),
  }
}

/** Where a link in view `embed` goes: the app's URL of `location` in its repository at what it shows. */
export const embedHref = (
  embed: Pick<EmbedRow, "owner" | "name">,
  shown: Extract<EmbedShown, { kind: "view" }>,
  location: Location,
): string => hrefFor({ owner: embed.owner, name: embed.name, defaultBranch: shown.defaultBranch }, shown.revision, location)

/**
 * Where a repository's view opens full screen: what it shows, once it is known, else what its props name: the
 * repository's root, or its location at the named ref (a path without a ref waits for the default branch's name, so it
 * opens at the root).
 */
export const fullScreenHref = (
  target: { readonly repo: string; readonly ref?: string | undefined; readonly kind?: "tree" | "blob" | undefined; readonly path?: string | undefined },
  row: EmbedQueryRow | undefined,
): string => {
  const shown = embedShown(row)
  if (row !== undefined && shown.kind === "view") return embedHref(row.embed, shown, shown.location)
  const base = `/${target.repo.split("/").map(encodeURIComponent).join("/")}`
  if (target.ref === undefined) return base
  const path = target.path ?? ""
  return `${base}/${target.kind ?? "tree"}/${encodePath(target.ref)}${path === "" ? "" : `/${encodePath(path)}`}`
}

/**
 * What Back to chat leaves in the conversation from the routed repository view (src/features/views/minimize.ts): the
 * repository, and its location unless it is the default branch's root, the ref only when it isn't the default branch.
 */
export const minimizedOf = (
  view: { readonly owner: string; readonly name: string; readonly kind: "tree" | "blob"; readonly path: string; readonly revision: string | null },
  defaultBranch: string | null,
): { readonly repo: string; readonly ref?: string; readonly kind?: "tree" | "blob"; readonly path?: string } => ({
  repo: `${view.owner}/${view.name}`,
  ...(view.revision === null || view.revision === defaultBranch ? {} : { ref: view.revision }),
  ...(view.path === "" ? {} : { kind: view.kind, path: view.path }),
})
