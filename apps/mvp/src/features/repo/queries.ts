import type { ElectricCollection } from "@smthrs/effect-electric"
import { type Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { Effect, Option } from "effect"
import { blobKey, readmeOf, treeKey } from "./paths"
import type { AboutRow, BlobRow, CloneRow, EmbedRow, RefsRow, TreeRow, ViewRow } from "./rows"
import type { Repository } from "./schema"

// What every frontend reads. The live queries follow the routed view's one row, so React renders them with
// `useLiveQuery` and a TUI reads their `rows` streams; the reads below answer for any repository and commit. None waits
// for the network: they read only what the device has.

type Rows<A extends object> = Collection.Collection<A, string>

/** The view, with its repository as Postgres has it and this tab's clone request for it, when there are. */
export const viewQuery = (
  view: Rows<ViewRow>,
  repositories: ElectricCollection.ElectricCollection<Repository>,
  clones: Rows<CloneRow>,
  abouts: Rows<AboutRow>,
) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .leftJoin({ repository: repositories.tanstack }, ({ view, repository }) => Query.eq(view.repoId, repository.id))
      .leftJoin({ clone: clones.tanstack }, ({ view, clone }) => Query.eq(view.repoId, clone.id))
      .leftJoin({ about: abouts.tanstack }, ({ view, about }) => Query.eq(view.repoId, about.key))
      .findOne(),
  )

/** The view, with the file list at its commit when this tab has loaded or is loading it. */
export const treeQuery = (view: Rows<ViewRow>, trees: Rows<TreeRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .leftJoin({ tree: trees.tanstack }, ({ view, tree }) => Query.eq(view.treeKey, tree.key))
      .findOne(),
  )

/** The view, with its repository's branches and tags when this tab has loaded or is loading them. */
export const refsQuery = (view: Rows<ViewRow>, refs: Rows<RefsRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .leftJoin({ refs: refs.tanstack }, ({ view, refs }) => Query.eq(view.refsKey, refs.key))
      .findOne(),
  )

/** The view, with what GitHub says of its repository when this tab has loaded or is loading it. */
export const aboutQuery = (view: Rows<ViewRow>, abouts: Rows<AboutRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .leftJoin({ about: abouts.tanstack }, ({ view, about }) => Query.eq(view.repoId, about.key))
      .findOne(),
  )

/** The view, with the repository's generated-files manifest at its commit, when it has one. */
export const manifestQuery = (view: Rows<ViewRow>, blobs: Rows<BlobRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .leftJoin({ manifest: blobs.tanstack }, ({ view, manifest }) => Query.eq(view.manifestKey, manifest.key))
      .findOne(),
  )

/** The view, with the file it shows. */
export const fileQuery = (view: Rows<ViewRow>, blobs: Rows<BlobRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .leftJoin({ file: blobs.tanstack }, ({ view, file }) => Query.eq(view.fileKey, file.key))
      .findOne(),
  )

/** The view, with the README of the directory it shows. */
export const readmeQuery = (view: Rows<ViewRow>, blobs: Rows<BlobRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .leftJoin({ readme: blobs.tanstack }, ({ view, readme }) => Query.eq(view.readmeKey, readme.key))
      .findOne(),
  )

/**
 * Every repository's view in a conversation this tab loaded, by its view's id (`embed.key`), with what it shows: what
 * GitHub says of the repository, its row as Postgres has it, the location's file list, and the file or README.
 */
export const embedsQuery = (
  embeds: Rows<EmbedRow>,
  repositories: ElectricCollection.ElectricCollection<Repository>,
  abouts: Rows<AboutRow>,
  trees: Rows<TreeRow>,
  blobs: Rows<BlobRow>,
) =>
  LiveQuery.make((q) =>
    q
      .from({ embed: embeds.tanstack })
      .leftJoin({ repository: repositories.tanstack }, ({ embed, repository }) => Query.eq(embed.repoId, repository.id))
      .leftJoin({ about: abouts.tanstack }, ({ embed, about }) => Query.eq(embed.repoId, about.key))
      .leftJoin({ tree: trees.tanstack }, ({ embed, tree }) => Query.eq(embed.treeKey, tree.key))
      .leftJoin({ body: blobs.tanstack }, ({ embed, body }) => Query.eq(embed.bodyKey, body.key))
  )

/**
 * Reads of any repository on this device (decision 0006 §2): its row, its file list at a commit, a file there, and a
 * directory's README there. Each is `None` until the device has it.
 */
export const reads = (store: {
  readonly repositories: ElectricCollection.ElectricCollection<Repository>
  readonly trees: Rows<TreeRow>
  readonly blobs: Rows<BlobRow>
}) => {
  const tree = (id: string, sha: string) => store.trees.get(treeKey(id, sha))
  return {
    repository: (id: string) => store.repositories.get(id),
    tree,
    file: (id: string, sha: string, path: string) => store.blobs.get(blobKey(id, sha, path)),
    readme: (id: string, sha: string, dir: string) =>
      Effect.flatMap(tree(id, sha), (found) => {
        const path = Option.isSome(found) && found.value.state === "ready" ? readmeOf(found.value.paths, dir) : undefined
        return path === undefined ? Effect.succeedNone : store.blobs.get(blobKey(id, sha, path))
      }),
  }
}
