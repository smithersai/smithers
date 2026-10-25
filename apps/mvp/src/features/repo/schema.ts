import { Schema } from "effect"
import { CAPACITY_REASONS, CLONE_STAGES, FAILURES, STATUSES } from "./contract"

// The repository feature's rows and RepoApi's answers, as the Effect Schemas they are checked with. Constants the
// browser shares with RepoApi live in contract.ts. A row kept on the device is read by the next version of the app
// too: change its shape only with its collection's `schemaVersion`.

/**
 * One row of Postgres `repositories` as Electric delivers it (docs/features/repo.md#repositories-postgres): columns in
 * camelCase, `stored_bytes` (int8) parsed to a number, timestamps as Postgres prints them.
 */
export const Repository = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  status: Schema.Literals(STATUSES),
  failure: Schema.NullOr(Schema.Literals(FAILURES)),
  capacity: Schema.NullOr(Schema.Literals(CAPACITY_REASONS)),
  storedBytes: Schema.NullOr(Schema.Number),
  retryAt: Schema.NullOr(Schema.String),
  defaultBranch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  headMessage: Schema.NullOr(Schema.String),
  headAuthor: Schema.NullOr(Schema.String),
  headAt: Schema.NullOr(Schema.String),
  attempt: Schema.Number,
  cloneId: Schema.String,
  requestedAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
  /**
   * When its branches or tags last changed in a way the app knows of (a ready clone, a branch the app made); the refs a
   * device keeps are keyed by it. Absent from a database before migration 0038, and null until such a change.
   */
  refsChangedAt: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * How far a `cloning` row has come; `null` otherwise. Absent from a database before migration 0028, which the device
   * reads as no stage.
   */
  stage: Schema.optional(Schema.NullOr(Schema.Literals(CLONE_STAGES))),
  /**
   * A ready copy of a repository the Smithers GitHub App isn't installed on: storage may reclaim it. Absent from a
   * database before migration 0028, which the device reads as not reclaimable.
   */
  reclaimable: Schema.optional(Schema.Boolean),
})
export type Repository = typeof Repository.Type

/** `GET /api/repos/<owner>/<name>/tree/<sha>`'s body: every file's path, and whether the listing stopped early. */
export const TreeListing = Schema.Struct({ paths: Schema.Array(Schema.String), truncated: Schema.Boolean })
export type TreeListing = typeof TreeListing.Type

/** A branch or a tag: its name and the commit it names. */
export const Ref = Schema.Struct({ name: Schema.String, sha: Schema.String })
export type Ref = typeof Ref.Type

/**
 * A repository's branches and tags as Code Storage lists them at one sync, each in name order, and whether either list
 * stopped before the end: what RepoApi keeps in the immutable cache under the default branch's head commit.
 */
export const RefsListing = Schema.Struct({
  branches: Schema.Array(Ref),
  tags: Schema.Array(Ref),
  truncated: Schema.Boolean,
})
export type RefsListing = typeof RefsListing.Type

/**
 * `GET /api/repos/<owner>/<name>/refs`'s body: the default branch and its head commit, as Postgres has them, and every
 * branch and tag as of that sync.
 */
export const Refs = Schema.Struct({
  defaultBranch: Schema.String,
  head: Schema.String,
  ...RefsListing.fields,
})
export type Refs = typeof Refs.Type

/** A file or folder at the top of a repository, as GitHub lists it before a clone. */
export const AboutEntry = Schema.Struct({ name: Schema.String, kind: Schema.Literals(["file", "dir"]) })
export type AboutEntry = typeof AboutEntry.Type

/** A commit as the about answer names it: its SHA, its message, who wrote it, and when (ISO). */
export const AboutCommit = Schema.Struct({
  sha: Schema.String,
  message: Schema.String,
  author: Schema.String,
  at: Schema.String,
})
export type AboutCommit = typeof AboutCommit.Type

/**
 * `GET /api/repos/<owner>/<name>/about`'s body: what GitHub says of a repository, cloned or not (docs/features/repo.md#about).
 * `name` is GitHub's own `owner/name`. Counts are `null` when GitHub didn't give them; `root` and `readme` are GitHub's
 * top folder and README at the default branch, for the page before a clone; `home` is the repository's
 * `.smithers/home.json` text at `head`, `null` when it has none GitHub gave (absent from an answer cached before it was
 * read); `installUrl` is where the Smithers GitHub App is installed.
 */
export const About = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  homepage: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  stars: Schema.Number,
  forks: Schema.Number,
  watchers: Schema.Number,
  license: Schema.NullOr(Schema.String),
  defaultBranch: Schema.String,
  archived: Schema.Boolean,
  languages: Schema.Array(Schema.Struct({ name: Schema.String, bytes: Schema.Number })),
  release: Schema.NullOr(
    Schema.Struct({ tag: Schema.String, name: Schema.NullOr(Schema.String), publishedAt: Schema.NullOr(Schema.String) }),
  ),
  releases: Schema.NullOr(Schema.Number),
  contributors: Schema.Array(Schema.Struct({ login: Schema.String, avatarUrl: Schema.String })),
  contributorCount: Schema.NullOr(Schema.Number),
  commits: Schema.NullOr(Schema.Number),
  branches: Schema.NullOr(Schema.Number),
  tags: Schema.NullOr(Schema.Number),
  head: Schema.NullOr(AboutCommit),
  root: Schema.NullOr(Schema.Array(AboutEntry)),
  readme: Schema.NullOr(Schema.Struct({ path: Schema.String, text: Schema.String })),
  home: Schema.optionalKey(Schema.NullOr(Schema.String)),
  installUrl: Schema.NullOr(Schema.String),
})
export type About = typeof About.Type

/** `POST /api/repos`'s answer: `202` with the transaction to wait for, or `200` for a clone already running or done. */
export const CloneAccepted = Schema.Union([
  Schema.Struct({ txid: Schema.Number, id: Schema.String, attempt: Schema.Number, cloneId: Schema.String }),
  Schema.Struct({ txid: Schema.Null, id: Schema.String, status: Schema.Literals(STATUSES), cloneId: Schema.String }),
])
export type CloneAccepted = typeof CloneAccepted.Type

/** What a clone's launch did: started its remote `repo/Clone`, or found the attempt superseded or settled. */
export const CloneLaunched = Schema.Union([
  Schema.Struct({ launched: Schema.Literal(true) }),
  Schema.Struct({ launched: Schema.Literal(false), status: Schema.Literals(STATUSES) }),
])
export type CloneLaunched = typeof CloneLaunched.Type

/** A refusal's body: its code, and a too-large file's size. */
export const RefusalBody = Schema.Struct({ code: Schema.String, size: Schema.optional(Schema.Number) })
export type RefusalBody = typeof RefusalBody.Type

/**
 * What `repo/copy`'s step asks the tab that started its request (src/flows/askingTab.ts): put `text` on its clipboard,
 * or, without one, only say which door it started the request through. The tab answers `Copied` (flows.ts).
 */
export const CopyCall = Schema.Struct({ text: Schema.optional(Schema.String) })
