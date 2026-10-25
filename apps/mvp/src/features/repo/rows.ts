import { Schema } from "effect"
import { About, Ref } from "./schema"

// This tab's own repository rows, in memory: what it has loaded and where the view is. Synced rows (`Repository`) and
// RepoApi's answers are in schema.ts.

/** A repository's file list at a commit, keyed `<id>@<sha>`, as the view takes it: loading, ready or failed. */
export const TreeRow = Schema.Struct({
  key: Schema.String,
  state: Schema.Literals(["loading", "ready", "failed"]),
  paths: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
})
export type TreeRow = typeof TreeRow.Type

/**
 * One file at a commit, keyed `<id>@<sha>:<path>`, as the view takes it: loading, its text, binary or too large (with
 * its size in bytes), or failed.
 */
export const BlobRow = Schema.Struct({
  key: Schema.String,
  state: Schema.Literals(["loading", "text", "binary", "too-large", "failed"]),
  contents: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
})
export type BlobRow = typeof BlobRow.Type

/**
 * A repository's branches and tags as of one sync, keyed `<id>@<headSha>`, as the picker takes them: loading, ready
 * (each list in name order, and whether either stopped early) or failed.
 */
export const RefsRow = Schema.Struct({
  key: Schema.String,
  state: Schema.Literals(["loading", "ready", "failed"]),
  branches: Schema.Array(Ref),
  tags: Schema.Array(Ref),
  truncated: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
})
export type RefsRow = typeof RefsRow.Type

/**
 * A clone this tab asked for that Postgres doesn't show yet, keyed by the repository's id: `requesting` until Electric
 * delivers the row; or why RepoApi didn't take it: `sign_in` (401), `limit` (429) or `failed` (anything else).
 */
export const CloneRow = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["requesting", "sign_in", "limit", "failed"]),
})
export type CloneRow = typeof CloneRow.Type

/**
 * What GitHub says of a repository, keyed by its id, as this tab loaded it: loading, ready with `about`, `missing`
 * (GitHub has no such public repository) or failed (GitHub or RepoApi couldn't answer, with why).
 */
export const AboutRow = Schema.Struct({
  key: Schema.String,
  state: Schema.Literals(["loading", "ready", "missing", "failed"]),
  about: Schema.NullOr(About),
  message: Schema.NullOr(Schema.String),
})
export type AboutRow = typeof AboutRow.Type

/**
 * A repository's ready head as RepoApi's refs named it for this tab, keyed by the repository's id: the default branch and
 * head commit Postgres has, read before Electric delivered the repository's row (actions.ts `ensureHead`). Loading,
 * ready, absent (Postgres has no ready clone: not cloned, cloning, failed or refused) or failed (RepoApi couldn't
 * answer).
 */
export const HeadRow = Schema.Struct({
  key: Schema.String,
  state: Schema.Literals(["loading", "ready", "absent", "failed"]),
  defaultBranch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
})
export type HeadRow = typeof HeadRow.Type

/** The one view row's key. */
export const VIEW = "view"

/**
 * Where the routed view is, one row. What the URL said (`owner`, `name`, `kind`, `ref`, `splat`, `line`, `lineEnd`),
 * then what it resolved to once the repository is ready: the `revision` links use (a branch, a tag or a SHA), the
 * commit `sha`, the `path`, the repository's `defaultBranch`, and the keys of the branches and tags, the tree, the file
 * and the directory's README. A `sha` says the load found the clone ready, from the repository's synced row or from
 * RepoApi's refs before Electric delivered that row.
 * `missing` when the URL names no repository or a ref the repository doesn't have; `failure` when the branches and
 * tags the ref needed couldn't load, and why. `signedIn` is sign-in's answer, `null` until it gives one. `answered`:
 * the repositories' shape has answered once, with its rows or a failure.
 */
export const ViewRow = Schema.Struct({
  id: Schema.Literal(VIEW),
  owner: Schema.String,
  name: Schema.String,
  repoId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["tree", "blob"]),
  ref: Schema.NullOr(Schema.String),
  splat: Schema.String,
  line: Schema.NullOr(Schema.Number),
  lineEnd: Schema.NullOr(Schema.Number),
  missing: Schema.Boolean,
  failure: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.String),
  sha: Schema.NullOr(Schema.String),
  path: Schema.String,
  defaultBranch: Schema.NullOr(Schema.String),
  refsKey: Schema.NullOr(Schema.String),
  treeKey: Schema.NullOr(Schema.String),
  fileKey: Schema.NullOr(Schema.String),
  readmeKey: Schema.NullOr(Schema.String),
  readmePath: Schema.NullOr(Schema.String),
  /**
   * The generated-files manifest nearest the view's location at its commit (`.smithers/generated.json` in its folder or
   * one above), and its key; `null` when no folder on the way has one.
   */
  manifestPath: Schema.NullOr(Schema.String),
  manifestKey: Schema.NullOr(Schema.String),
  signedIn: Schema.NullOr(Schema.Boolean),
  answered: Schema.Boolean,
})
export type ViewRow = typeof ViewRow.Type

/** The view row before any route opened it. */
export const emptyView: ViewRow = {
  id: VIEW,
  owner: "",
  name: "",
  repoId: null,
  kind: "tree",
  ref: null,
  splat: "",
  line: null,
  lineEnd: null,
  missing: true,
  failure: null,
  revision: null,
  sha: null,
  path: "",
  defaultBranch: null,
  refsKey: null,
  treeKey: null,
  fileKey: null,
  readmeKey: null,
  readmePath: null,
  manifestPath: null,
  manifestKey: null,
  signedIn: null,
  answered: false,
}

/**
 * A repository's view in a conversation, as this tab loaded it (docs/features/views.md#a-repository-and-its-issues), by
 * the view's id. One per view, in memory:
 * - `loading` until the tab can tell what to show;
 * - `ready`: a cloned repository at `revision` (`sha`), with the location's file list (`treeKey`) and the file it shows,
 *   or the directory's README (`bodyKey`, `bodyPath`);
 * - `preview`: a repository nobody cloned, at its root: what GitHub says of it (the about row) shows instead;
 * - `not_cloned`: below the root of a repository nobody cloned, which only its full-screen page can clone;
 * - `missing`: GitHub has no such repository, or the repository no such ref; `failed`: why it couldn't load.
 */
export const EmbedRow = Schema.Struct({
  key: Schema.String,
  repoId: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["tree", "blob"]),
  path: Schema.String,
  state: Schema.Literals(["loading", "ready", "preview", "not_cloned", "missing", "failed"]),
  message: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.String),
  sha: Schema.NullOr(Schema.String),
  treeKey: Schema.NullOr(Schema.String),
  bodyKey: Schema.NullOr(Schema.String),
  bodyPath: Schema.NullOr(Schema.String),
})
export type EmbedRow = typeof EmbedRow.Type
