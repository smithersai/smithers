import { Home } from "@smthrs/views"
import { Schema } from "effect"
import { Section } from "./schema"

// This tab's home rows: what each home it read at a commit declares, Smithers' curated home for a repository, the files
// a home's Markdown blocks read, and which repository's home the routed page shows.

/**
 * A repository's home at one commit, keyed `<repoId>@<sha>`, which never changes once read: `declared` with its
 * sections and how many blocks of an unknown kind were skipped; `absent` when the repository has no
 * `.smithers/home.json`; `invalid` when the file isn't a home (with `Home.read`'s reason, or `binary` or `too_large`);
 * `unreadable` when RepoApi couldn't answer, read again on the next open. It holds every section: the page shows the
 * viewer only the ones their audience may see.
 */
export const HomeRow = Schema.Struct({
  key: Schema.String,
  state: Schema.Literals(["declared", "absent", "invalid", "unreadable"]),
  sections: Schema.Array(Section),
  /** Who counts as a contributor to it: `anyone` when the file opens its contributors' sections to everyone. */
  contributors: Home.Contributors,
  skipped: Schema.Number,
  reason: Schema.NullOr(Schema.String),
})
export type HomeRow = typeof HomeRow.Type

/**
 * Smithers' curated home for a repository, keyed by the repository's id, as ChatApi last answered it for this device's
 * person: `declared` with its default branch and the sections their audience may see, or `absent` when Smithers has
 * none. Read again on every open; an answer that fails keeps the row.
 */
export const CuratedRow = Schema.Struct({
  key: Schema.String,
  state: Schema.Literals(["declared", "absent"]),
  defaultBranch: Schema.NullOr(Schema.String),
  sections: Schema.Array(Section),
})
export type CuratedRow = typeof CuratedRow.Type

/** One Markdown block's file, keyed `<homeKey>:<path>`: loading, its text, or failed (missing, binary, too large). */
export const FileRow = Schema.Struct({
  key: Schema.String,
  home: Schema.String,
  path: Schema.String,
  state: Schema.Literals(["loading", "text", "failed"]),
  text: Schema.NullOr(Schema.String),
})
export type FileRow = typeof FileRow.Type

/** The one row that says whose home the page shows. */
export const CURRENT = "current"

/**
 * Whose home the routed page shows: the repository and its id (`null` for a name GitHub couldn't have); once it is
 * ready on this device its home's key (`null` before) and its default branch; who ChatApi says the person is on it
 * (`null` until it answers); the lower view the person switched to (`null`: their own, the highest they may see,
 * SCOPE-14); whether the curated home's answer is still on its way; whether the repository's own home is still being
 * read from what GitHub says, before a clone; the repository whose stack this tab opened for a
 * `stack` block, and whose issues for an `issues` block (`null` before); the action blocks' flows running now; and why the last one failed, `null` when it
 * didn't.
 */
export const CurrentRow = Schema.Struct({
  id: Schema.Literal(CURRENT),
  owner: Schema.String,
  name: Schema.String,
  repoId: Schema.NullOr(Schema.String),
  key: Schema.NullOr(Schema.String),
  defaultBranch: Schema.NullOr(Schema.String),
  audience: Schema.NullOr(Home.Audience),
  viewing: Schema.NullOr(Home.Audience),
  answering: Schema.Boolean,
  previewing: Schema.Boolean,
  /** The docs index the repository's own home names at its newest commit, from what GitHub says; `null` for none. */
  docs: Schema.NullOr(Schema.String),
  /** The docs index Smithers' curated home for it names, as ChatApi answered; `null` for none. */
  curatedDocs: Schema.NullOr(Schema.String),
  stack: Schema.NullOr(Schema.String),
  issues: Schema.NullOr(Schema.String),
  running: Schema.Array(Schema.String),
  failure: Schema.NullOr(Schema.String),
})
export type CurrentRow = typeof CurrentRow.Type

/** The current row before any route opened a repository. */
export const emptyCurrent: CurrentRow = {
  id: CURRENT,
  owner: "",
  name: "",
  repoId: null,
  key: null,
  defaultBranch: null,
  audience: null,
  viewing: null,
  answering: false,
  previewing: false,
  docs: null,
  curatedDocs: null,
  stack: null,
  issues: null,
  running: [],
  failure: null,
}

/** A home's key: the repository's id at the commit its home was read at. */
export const homeKey = (repoId: string, sha: string): string => `${repoId}@${sha}`

/** A Markdown block's file's key. */
export const fileKey = (home: string, path: string): string => `${home}:${path}`
