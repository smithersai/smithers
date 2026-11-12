/**
 * @since 1.0.0
 *
 * The `Repository` service: a git repository's objects and refs, as a host
 * capability beside {@link Jj}.
 *
 * `Jj` snapshots and restores a working copy. A flow that publishes history
 * needs the layer under it: write a blob, a tree and a commit, read them back,
 * and move several refs at once without racing a second writer. This module is
 * that contract, with no process and no `git` command: a hosting adapter (such
 * as `@smthrs/integrations`' `GitHub.GitDatabase`) or the memory adapter here
 * answers it.
 *
 * - **Objects are content addressed.** Every write answers the object's git
 *   id, which {@link hashBlob}, {@link hashTree} and {@link hashCommit}
 *   compute the same way git does, so a caller can plan ids before it writes
 *   and an adapter refuses an answer that is not the object's id. Writing an
 *   object twice writes it once.
 * - **Refs move only by compare-and-swap.** {@link Repository.updateRefs}
 *   takes every ref's old value, checks all of them, and moves all of them or
 *   none. There is no unconditional write: a caller that does not know a
 *   ref's value reads it first. An adapter that cannot make the transaction
 *   atomic, or cannot check an old value, fails `unsupported`; it never
 *   imitates atomicity with separate writes.
 * - **Notes are refs.** `refs/notes/<name>` points at a commit whose tree maps
 *   each annotated commit's full id to a blob, as `git notes` writes it. The
 *   objects and the transaction above are all a notes writer needs.
 *
 * Feature detection is by error code, as for `Jj`: `unsupported` means this
 * adapter cannot do it.
 */

import { Context, Effect, Layer, Schema } from "effect"

/**
 * Why a repository operation failed, as a closed and stable set.
 *
 * `unsupported` — this adapter cannot do it, such as an atomic multi-ref
 * update, or it is switched off. `conflict` — a ref's old value was not the
 * one given; nothing moved. `not_found` — no object or ref has that id.
 * `invalid` — the input breaks a rule the call states, or names an object the
 * repository lacks. `unavailable` — the repository could not be reached or
 * answered something else; whether a write landed is unknown until read back.
 *
 * Callers branch on these codes; add a code, never repurpose one.
 *
 * @category models
 * @since 1.0.0
 */
export const RepositoryErrorCode = Schema.Literals(["unsupported", "conflict", "not_found", "invalid", "unavailable"])

/**
 * The value form of {@link RepositoryErrorCode}.
 *
 * @category models
 * @since 1.0.0
 */
export type RepositoryErrorCode = typeof RepositoryErrorCode.Type

/**
 * A repository failure: its stable `code`, the `method` that failed, a human
 * `message`, for a `conflict` the refs whose old value differed, and for an
 * `unavailable` repository that asked callers to wait (a rate limit) how long,
 * as `retryAfterMillis`.
 *
 * The tag is durable identity: a flow journals the error. `retryAfterMillis`
 * is the name `@smthrs/flow`'s retry policy reads, so a step that fails with
 * it waits at least that long before its next attempt.
 *
 * @category errors
 * @since 1.0.0
 */
export class RepositoryError extends Schema.TaggedError<RepositoryError>()("@smthrs/jj/RepositoryError", {
  code: RepositoryErrorCode,
  method: Schema.String,
  message: Schema.String,
  refs: Schema.optional(Schema.Array(Schema.String)),
  retryAfterMillis: Schema.optional(Schema.Number)
}) {}

/**
 * Creates a {@link RepositoryError} whose message reads `<code>: Repository.<method>: <description>`. A finite,
 * non-negative `retryAfterMillis` is kept; any other is dropped.
 *
 * @throws {never} It only builds the error; a caller fails with it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const repositoryError = (
  code: RepositoryErrorCode,
  method: string,
  description: string,
  refs?: ReadonlyArray<string>,
  retryAfterMillis?: number
): RepositoryError =>
  new RepositoryError({
    code,
    method,
    message: `${code}: Repository.${method}: ${description}`,
    ...(refs === undefined ? {} : { refs: [...refs] }),
    ...(retryAfterMillis !== undefined && Number.isFinite(retryAfterMillis) && retryAfterMillis >= 0
      ? { retryAfterMillis }
      : {})
  })

/**
 * Refines a failure to a {@link RepositoryError}.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isRepositoryError = (error: unknown): error is RepositoryError =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "@smthrs/jj/RepositoryError"

/**
 * A git object id: 40 lowercase hex digits.
 *
 * @category models
 * @since 1.0.0
 */
export type ObjectId = string

const OBJECT_ID = /^[0-9a-f]{40}$/
const PREFIX = /^[0-9a-f]{4,40}$/

/**
 * Whether `value` is a full {@link ObjectId}.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isObjectId = (value: unknown): value is ObjectId => typeof value === "string" && OBJECT_ID.test(value)

/**
 * The id of git's empty tree.
 *
 * @category constants
 * @since 1.0.0
 */
export const EMPTY_TREE: ObjectId = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/**
 * A tree entry's mode: a file, an executable, a symbolic link, a tree, or a
 * submodule's commit. Git writes a tree's mode as `40000`; this API, as
 * GitHub's, names it `040000`.
 *
 * @category models
 * @since 1.0.0
 */
export type Mode = "100644" | "100755" | "120000" | "040000" | "160000"

const MODES: ReadonlySet<string> = new Set(["100644", "100755", "120000", "040000", "160000"])

/**
 * One entry of a tree: a name inside the tree (no `/`), its mode, and the
 * object it names.
 *
 * @category models
 * @since 1.0.0
 */
export interface TreeEntry {
  readonly name: string
  readonly mode: Mode
  readonly oid: ObjectId
}

/**
 * Who wrote or committed a commit, and when, in whole seconds since the epoch.
 * Every commit this API writes is in UTC (`+0000`).
 *
 * @category models
 * @since 1.0.0
 */
export interface Person {
  readonly name: string
  readonly email: string
  readonly seconds: number
}

/**
 * A commit to write: its tree, parents in order, author, committer and whole
 * message, byte for byte.
 *
 * @category models
 * @since 1.0.0
 */
export interface CommitObject {
  readonly tree: ObjectId
  readonly parents: ReadonlyArray<ObjectId>
  readonly author: Person
  readonly committer: Person
  readonly message: string
}

/**
 * A commit as {@link Repository.readCommit} reads it: its id, tree, parents
 * and message.
 *
 * `oid` is the full id, except for a commit a memory repository was given by
 * a shorter id (see {@link MemoryOptions}), which answers that id.
 *
 * @category models
 * @since 1.0.0
 */
export interface CommitHeader {
  readonly oid: string
  readonly tree: ObjectId
  readonly parents: ReadonlyArray<ObjectId>
  readonly message: string
}

/**
 * A ref and the object it points at; `null` when the ref does not exist.
 *
 * @category models
 * @since 1.0.0
 */
export interface RefValue {
  readonly ref: string
  readonly oid: ObjectId | null
}

/**
 * One ref of a transaction: the value it must hold now (`null`: it must not
 * exist) and the value it takes (`null`: it is deleted). `before` equal to
 * `after` checks a ref without moving it.
 *
 * @category models
 * @since 1.0.0
 */
export interface RefUpdate {
  readonly ref: string
  readonly before: ObjectId | null
  readonly after: ObjectId | null
}

/**
 * An atomic compare-and-swap over several refs. `operation` names the write
 * for the adapter's logs and, where the host keeps one, its request id: 1 to
 * 128 letters, digits, `.`, `_`, `:`, `/` or `-`.
 *
 * @category models
 * @since 1.0.0
 */
export interface RefTransaction {
  readonly operation: string
  readonly updates: ReadonlyArray<RefUpdate>
}

/**
 * The most refs one transaction moves.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_REF_UPDATES = 25

/**
 * A git repository's objects and refs.
 *
 * Every method's error channel is {@link RepositoryError}. A read of a missing
 * object fails `not_found`; a write naming a missing object fails `invalid`.
 *
 * @category services
 * @since 1.0.0
 */
export interface Repository {
  /** A blob's content, read as UTF-8. */
  readonly readBlob: (oid: ObjectId) => Effect.Effect<string, RepositoryError>
  /** Writes `text`, encoded as UTF-8, and answers its id. */
  readonly writeBlob: (text: string) => Effect.Effect<ObjectId, RepositoryError>
  /** A tree's entries in git's order. */
  readonly readTree: (oid: ObjectId) => Effect.Effect<ReadonlyArray<TreeEntry>, RepositoryError>
  /** Writes one tree level of `entries` (names unique) and answers its id. */
  readonly writeTree: (entries: ReadonlyArray<TreeEntry>) => Effect.Effect<ObjectId, RepositoryError>
  /**
   * The commit `revision` names: a full id, or a prefix of 4 to 39 hex digits
   * that names exactly one commit (`invalid` when several).
   */
  readonly readCommit: (revision: string) => Effect.Effect<CommitHeader, RepositoryError>
  /** Writes a commit and answers its id. */
  readonly writeCommit: (commit: CommitObject) => Effect.Effect<ObjectId, RepositoryError>
  /** Each ref's value, in the order asked. */
  readonly readRefs: (refs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<RefValue>, RepositoryError>
  /**
   * Moves every ref of `transaction` or none: each must hold its `before`
   * value, else the whole transaction fails `conflict` naming the refs that
   * differed. An adapter that cannot do this atomically fails `unsupported`.
   */
  readonly updateRefs: (transaction: RefTransaction) => Effect.Effect<void, RepositoryError>
}

/**
 * The service key for {@link Repository}. The tag string is durable identity.
 *
 * @category services
 * @since 1.0.0
 */
export const Repository: Context.Service<Repository, Repository> = Context.Service("@smthrs/jj/Repository")

// ── validation ──────────────────────────────────────────────────────────────

const REF_SEGMENT = /^[A-Za-z0-9._-]+$/
const OPERATION = /^[A-Za-z0-9._:/-]{1,128}$/

/**
 * Whether `ref` is a ref name this API accepts: `refs/` and then segments of
 * letters, digits, `.`, `_` and `-`, none empty, none starting with `.` or
 * ending with `.lock`, with no `..`, at most 255 characters: a subset of git's
 * `check-ref-format`.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isRefName = (ref: unknown): ref is string =>
  typeof ref === "string" && ref.length <= 255 && ref.startsWith("refs/") && !ref.includes("..") &&
  ref.split("/").length >= 3 &&
  ref.split("/").every((segment) => REF_SEGMENT.test(segment) && !segment.startsWith(".") && !segment.endsWith(".lock"))

const isEntryName = (name: unknown): name is string =>
  typeof name === "string" && name.length > 0 && name.length <= 255 && name !== "." && name !== ".." &&
  !name.includes("/") && !name.includes("\0")

const isPerson = (person: unknown): person is Person => {
  if (typeof person !== "object" || person === null) return false
  const { email, name, seconds } = person as Person
  return typeof name === "string" && typeof email === "string" && !/[<>\n\0]/.test(name + email) &&
    name.trim() === name && email.trim() === email && name !== "" && Number.isSafeInteger(seconds) && seconds >= 0
}

const invalid = (method: string, description: string) => Effect.fail(repositoryError("invalid", method, description))

/**
 * `oid` when it is a full object id, else an `invalid` failure for `method`.
 *
 * @category validation
 * @since 1.0.0
 */
export const requireObjectId = (method: string, oid: unknown): Effect.Effect<ObjectId, RepositoryError> =>
  isObjectId(oid) ? Effect.succeed(oid) : invalid(method, "an object id is 40 lowercase hex digits")

/**
 * `revision` when it is a full id or a hex prefix of at least 4 digits.
 *
 * @category validation
 * @since 1.0.0
 */
export const requireRevision = (method: string, revision: unknown): Effect.Effect<string, RepositoryError> =>
  typeof revision === "string" && PREFIX.test(revision)
    ? Effect.succeed(revision)
    : invalid(method, "a revision is 4 to 40 lowercase hex digits")

/**
 * The entries when each has a valid name, mode and id and no two share a name.
 *
 * @category validation
 * @since 1.0.0
 */
export const requireEntries = (
  method: string,
  entries: ReadonlyArray<TreeEntry>
): Effect.Effect<ReadonlyArray<TreeEntry>, RepositoryError> => {
  if (!Array.isArray(entries)) return invalid(method, "a tree is a list of entries")
  for (const entry of entries) {
    if (!isEntryName(entry?.name) || !MODES.has(entry.mode) || !isObjectId(entry.oid)) {
      return invalid(method, "an entry is a name without '/', a mode and an object id")
    }
  }
  return new Set(entries.map((entry) => entry.name)).size === entries.length
    ? Effect.succeed(entries)
    : invalid(method, "two entries share a name")
}

/**
 * The commit when its tree and parents are ids, its people valid and its
 * message a string.
 *
 * @category validation
 * @since 1.0.0
 */
export const requireCommit = (method: string, commit: CommitObject): Effect.Effect<CommitObject, RepositoryError> => {
  if (typeof commit !== "object" || commit === null || !isObjectId(commit.tree)) {
    return invalid(method, "a commit names its tree by id")
  }
  if (!Array.isArray(commit.parents) || !commit.parents.every(isObjectId)) {
    return invalid(method, "a commit names its parents by id")
  }
  if (!isPerson(commit.author) || !isPerson(commit.committer)) {
    return invalid(method, "a person is a name and an email without '<', '>' or a line break, and whole seconds")
  }
  return typeof commit.message === "string" ? Effect.succeed(commit) : invalid(method, "a message is text")
}

/**
 * The refs when each is a valid name and none repeats; at least one.
 *
 * @category validation
 * @since 1.0.0
 */
export const requireRefs = (
  method: string,
  refs: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<string>, RepositoryError> =>
  Array.isArray(refs) && refs.length > 0 && refs.length <= MAX_REF_UPDATES && refs.every(isRefName) &&
    new Set(refs).size === refs.length
    ? Effect.succeed(refs)
    : invalid(method, `1 to ${MAX_REF_UPDATES} distinct ref names under refs/`)

/**
 * The transaction when its operation is valid, it moves 1 to
 * {@link MAX_REF_UPDATES} distinct refs, and each old and new value is an id
 * or `null`.
 *
 * @category validation
 * @since 1.0.0
 */
export const requireTransaction = (
  method: string,
  transaction: RefTransaction
): Effect.Effect<RefTransaction, RepositoryError> => {
  if (typeof transaction?.operation !== "string" || !OPERATION.test(transaction.operation)) {
    return invalid(method, "an operation is 1 to 128 letters, digits, '.', '_', ':', '/' or '-'")
  }
  const updates = transaction.updates
  if (!Array.isArray(updates)) return invalid(method, "a transaction lists its updates")
  for (const update of updates) {
    const value = (oid: unknown) => oid === null || isObjectId(oid)
    if (!value(update?.before) || !value(update.after)) {
      return invalid(method, "an old or new value is an object id or null")
    }
  }
  return Effect.as(requireRefs(method, updates.map((update) => update.ref)), transaction)
}

// ── hashing ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder()

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const fromHex = (oid: ObjectId): Uint8Array => Uint8Array.from(oid.match(/../g)!, (pair) => Number.parseInt(pair, 16))

/**
 * The git id of an object of `kind` whose body is `body`: the SHA-1 of
 * `<kind> <length>\0<body>`, through WebCrypto.
 *
 * @category hashing
 * @since 1.0.0
 */
export const hashObject = (kind: "blob" | "tree" | "commit", body: Uint8Array): Effect.Effect<ObjectId> =>
  Effect.promise(() =>
    globalThis.crypto.subtle.digest("SHA-1", concat([encoder.encode(`${kind} ${body.length}\0`), body]))
  ).pipe(Effect.map((digest) => hex(new Uint8Array(digest))))

/**
 * A tree's body as git writes it: entries sorted as git sorts them (a tree's
 * name as if it ended in `/`), each `<mode> <name>\0<20-byte id>`.
 *
 * @category hashing
 * @since 1.0.0
 */
export const encodeTree = (entries: ReadonlyArray<TreeEntry>): Uint8Array =>
  concat(
    sortEntries(entries).flatMap((entry) => [
      encoder.encode(`${entry.mode === "040000" ? "40000" : entry.mode} ${entry.name}\0`),
      fromHex(entry.oid)
    ])
  )

// Git's tree order: bytewise by name, a tree's name read as if it ended in `/`.
const sortEntries = (entries: ReadonlyArray<TreeEntry>): ReadonlyArray<TreeEntry> => {
  const key = (entry: TreeEntry) => encoder.encode(entry.mode === "040000" ? `${entry.name}/` : entry.name)
  return entries.map((entry) => ({ entry, key: key(entry) })).sort((a, b) => compareBytes(a.key, b.key)).map((
    { entry }
  ) => entry)
}

const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!
  }
  return a.length - b.length
}

const signature = (person: Person) => `${person.name} <${person.email}> ${person.seconds} +0000`

/**
 * A commit's body as git writes it: `tree`, each `parent`, `author` and
 * `committer` lines, a blank line, and the message unchanged.
 *
 * @category hashing
 * @since 1.0.0
 */
export const encodeCommit = (commit: CommitObject): Uint8Array =>
  encoder.encode(
    `tree ${commit.tree}\n${commit.parents.map((parent) => `parent ${parent}\n`).join("")}` +
      `author ${signature(commit.author)}\ncommitter ${signature(commit.committer)}\n\n${commit.message}`
  )

/**
 * The id git gives a blob of `text`, encoded as UTF-8.
 *
 * @category hashing
 * @since 1.0.0
 */
export const hashBlob = (text: string): Effect.Effect<ObjectId> => hashObject("blob", encoder.encode(text))

/**
 * The id git gives a tree of `entries`.
 *
 * @category hashing
 * @since 1.0.0
 */
export const hashTree = (entries: ReadonlyArray<TreeEntry>): Effect.Effect<ObjectId> =>
  hashObject("tree", encodeTree(entries))

/**
 * The id git gives `commit`.
 *
 * @category hashing
 * @since 1.0.0
 */
export const hashCommit = (commit: CommitObject): Effect.Effect<ObjectId> => hashObject("commit", encodeCommit(commit))

/**
 * Fails `invalid` unless an adapter's `answered` id is the `expected` one: a
 * host that stored something else, or answered for another object, is never
 * believed.
 *
 * @category validation
 * @since 1.0.0
 */
export const requireAnswer = (
  method: string,
  expected: ObjectId,
  answered: unknown
): Effect.Effect<ObjectId, RepositoryError> =>
  answered === expected ? Effect.succeed(expected) : invalid(method, "the repository answered another object's id")

// ── adapters ────────────────────────────────────────────────────────────────

/**
 * Brands an implementation as the {@link Repository} service.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (impl: Repository): Repository => Repository.of(impl)

/**
 * A repository that answers every call `unsupported` with `reason`: a host
 * whose adapter cannot write, or where writing is switched off.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeUnsupported = (reason: string): Repository => {
  const refuse = (method: string) => () => Effect.fail(repositoryError("unsupported", method, reason))
  return Repository.of({
    readBlob: refuse("readBlob"),
    writeBlob: refuse("writeBlob"),
    readTree: refuse("readTree"),
    writeTree: refuse("writeTree"),
    readCommit: refuse("readCommit"),
    writeCommit: refuse("writeCommit"),
    readRefs: refuse("readRefs"),
    updateRefs: refuse("updateRefs")
  })
}

/**
 * Provides {@link makeUnsupported} as the `Repository` layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerUnsupported = (reason: string): Layer.Layer<Repository> =>
  Layer.succeed(Repository)(makeUnsupported(reason))

/**
 * What a memory repository starts with: `commits` it holds by the id given,
 * without their content (as a shallow import does), each with its tree; the
 * tree must be written before it is read.
 *
 * @category models
 * @since 1.0.0
 */
export interface MemoryOptions {
  readonly commits?: ReadonlyArray<{ readonly id: string; readonly tree: ObjectId }> | undefined
}

type Stored =
  | { readonly kind: "blob"; readonly text: string }
  | { readonly kind: "tree"; readonly entries: ReadonlyArray<TreeEntry> }
  | { readonly kind: "commit"; readonly header: CommitHeader }

/**
 * A repository in memory: objects hashed as git hashes them, and refs moved
 * by an atomic compare-and-swap. It holds git's empty tree from the start, as
 * git does. For mock modes and tests; nothing persists.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeMemory = (options?: MemoryOptions): Repository => {
  // Git knows the empty tree without storing it, so a commit may name it before anything is written.
  const objects = new Map<string, Stored>([[EMPTY_TREE, { kind: "tree", entries: [] }]])
  const refs = new Map<string, ObjectId>()
  for (const commit of options?.commits ?? []) {
    objects.set(commit.id, { kind: "commit", header: { oid: commit.id, tree: commit.tree, parents: [], message: "" } })
  }
  const read = <K extends Stored["kind"]>(method: string, kind: K, oid: string) => {
    const stored = objects.get(oid)
    return stored !== undefined && stored.kind === kind
      ? Effect.succeed(stored as Extract<Stored, { kind: K }>)
      : Effect.fail(repositoryError("not_found", method, `no ${kind} has that id`))
  }
  const has = (oid: ObjectId, kind: Stored["kind"]) => objects.get(oid)?.kind === kind
  const store = (oid: ObjectId, stored: Stored) => {
    if (!objects.has(oid)) objects.set(oid, stored)
    return oid
  }
  return Repository.of({
    readBlob: (oid) =>
      requireObjectId("readBlob", oid).pipe(
        Effect.flatMap((id) => read("readBlob", "blob", id)),
        Effect.map((blob) => blob.text)
      ),
    writeBlob: (text) =>
      typeof text === "string"
        ? Effect.map(hashBlob(text), (oid) => store(oid, { kind: "blob", text }))
        : invalid("writeBlob", "a blob is text"),
    readTree: (oid) =>
      requireObjectId("readTree", oid).pipe(
        Effect.flatMap((id) => read("readTree", "tree", id)),
        Effect.map((tree) => tree.entries)
      ),
    writeTree: (entries) =>
      Effect.gen(function*() {
        yield* requireEntries("writeTree", entries)
        for (const entry of entries) {
          // A submodule's commit lives in another repository; every other entry names an object here.
          const kind = entry.mode === "040000" ? "tree" : entry.mode === "160000" ? undefined : "blob"
          if (kind !== undefined && !has(entry.oid, kind)) {
            return yield* invalid("writeTree", "an entry names an object the repository lacks")
          }
        }
        const sorted = sortEntries(entries)
        return store(yield* hashTree(sorted), { kind: "tree", entries: sorted })
      }),
    readCommit: (revision) =>
      Effect.gen(function*() {
        const wanted = yield* requireRevision("readCommit", revision)
        const exact = objects.get(wanted)
        const matches = exact?.kind === "commit"
          ? [exact]
          : [...objects].filter(([oid, stored]) => stored.kind === "commit" && oid.startsWith(wanted)).map((
            [, stored]
          ) => stored)
        if (matches.length > 1) return yield* invalid("readCommit", "the prefix names several commits")
        const found = matches[0]
        if (found?.kind !== "commit") {
          return yield* Effect.fail(repositoryError("not_found", "readCommit", "no commit has that id"))
        }
        return found.header
      }),
    writeCommit: (commit) =>
      Effect.gen(function*() {
        yield* requireCommit("writeCommit", commit)
        if (!has(commit.tree, "tree") || !commit.parents.every((parent) => has(parent, "commit"))) {
          return yield* invalid("writeCommit", "the commit names an object the repository lacks")
        }
        const oid = yield* hashCommit(commit)
        return store(oid, {
          kind: "commit",
          header: { oid, tree: commit.tree, parents: [...commit.parents], message: commit.message }
        })
      }),
    readRefs: (names) =>
      Effect.map(requireRefs("readRefs", names), (valid) => valid.map((ref) => ({ ref, oid: refs.get(ref) ?? null }))),
    updateRefs: (transaction) =>
      Effect.flatMap(requireTransaction("updateRefs", transaction), ({ updates }) =>
        Effect.suspend(() => {
          // Checked and applied in one synchronous turn: no other fiber can move a ref between the two.
          const moved = updates.filter((update) => (refs.get(update.ref) ?? null) !== update.before)
          if (moved.length > 0) {
            return Effect.fail(
              repositoryError("conflict", "updateRefs", "a ref no longer holds its old value", moved.map((u) => u.ref))
            )
          }
          if (!updates.every((update) => update.after === null || objects.has(update.after))) {
            return invalid("updateRefs", "a new value names an object the repository lacks")
          }
          for (const update of updates) {
            if (update.after === null) refs.delete(update.ref)
            else refs.set(update.ref, update.after)
          }
          return Effect.void
        }))
  })
}

/**
 * Provides a fresh {@link makeMemory} repository as the `Repository` layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerMemory = (options?: MemoryOptions): Layer.Layer<Repository> =>
  Layer.sync(Repository)(() => makeMemory(options))
