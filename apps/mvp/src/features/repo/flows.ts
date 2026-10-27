import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Context, type Effect, Layer, Schema } from "effect"
import { COPY_KINDS, isFilePath, isRepository, MAX_BLOB_BYTES, SHA_PATTERN } from "./contract"
import { About, CloneAccepted, CloneLaunched, Refs, TreeListing } from "./schema"

// The repository flows (decision 0006 §1, docs/features/repo.md#flows): `repo/tree` lists a cloned repository's files
// at a commit, `repo/read` reads one file there, and `repo/refs` lists its branches and tags. `repo/clone` asks RepoApi
// to clone a repository, which admits it and starts the remote `repo/Clone` (src/features/repo/clone.ts). `repo/copy`
// puts a link, a path, a file's text or the clone URL on the clipboard of the tab that asked
// (src/features/repo/copy.ts). Each is a model-invocable flow of one step: a person's button or slash command and the
// agent run the same declaration.
//
// `repo/about` reads what GitHub says of a repository for its page (src/features/repo/actions.ts), so a read GitHub
// refused for a moment is tried again by the engine, not lost until a reload.
//
// They run on this device (decision 0011 §2): neither holds the Code Storage key. What a step does is injected through
// `RepoReader`: on the device, a GET of RepoApi's read routes, whose answers every cache keeps forever; on the server
// and the Node host in the tests, RepoApi's own reader over Code Storage (worker/RepoReads.ts). One implementation
// answers the routes and the flows. Nothing here names a host.

/** A repository as the agent names it: `owner/name`. */
export const RepoName = Schema.String.check(
  Schema.makeFilter((value: string) => {
    const [owner, name, ...rest] = value.split("/")
    return rest.length === 0 && owner !== undefined && name !== undefined && isRepository(owner, name)
  }),
)

/** A full commit SHA. */
export const Revision = Schema.String.check(Schema.isPattern(SHA_PATTERN))

/** A file's path in the repository. */
export const FilePath = Schema.String.check(Schema.makeFilter(isFilePath))

/** The repository, the commit or the file isn't there. */
export class RepoNotFound extends Schema.TaggedError<RepoNotFound>()("@smthrs/mvp/repo/RepoNotFound", {}) {}

/** This month's Code Storage read budget is spent, and the answer wasn't cached. */
export class RepoReadsPaused extends Schema.TaggedError<RepoReadsPaused>()("@smthrs/mvp/repo/RepoReadsPaused", {}) {}

/**
 * Code Storage or RepoApi couldn't answer: busy, thawing a cold repository, or unreachable. `retryAfterMillis` is how
 * long the server asked to wait, which the step's retry policy honors. `reason` is GitHub's, for About's read: it rate
 * limited it, or didn't answer.
 */
export class RepoReadUnavailable extends Schema.TaggedError<RepoReadUnavailable>()(
  "@smthrs/mvp/repo/RepoReadUnavailable",
  {
    retryAfterMillis: Schema.optional(Schema.Number),
    reason: Schema.optional(Schema.Literals(["rate_limited", "github_unavailable"])),
  },
) {}

/** What a read can fail with. */
export const ReadFailure = Schema.Union([RepoNotFound, RepoReadsPaused, RepoReadUnavailable])
export type ReadFailure = typeof ReadFailure.Type

/**
 * One file as the agent reads it: its text, or only its size when it is binary or larger than `MAX_BLOB_BYTES`.
 * Sizes are in bytes.
 */
export const FileRead = Schema.Union([
  Schema.Struct({ state: Schema.Literal("text"), contents: Schema.String, size: Schema.Number }),
  Schema.Struct({ state: Schema.Literals(["binary", "too-large"]), size: Schema.Number }),
])
export type FileRead = typeof FileRead.Type

/** Where a read step reads: the host provides it. */
export class RepoReader extends Context.Service<
  RepoReader,
  {
    readonly tree: (owner: string, name: string, sha: string) => Effect.Effect<TreeListing, ReadFailure>
    readonly read: (owner: string, name: string, sha: string, path: string) => Effect.Effect<FileRead, ReadFailure>
    readonly refs: (owner: string, name: string) => Effect.Effect<Refs, ReadFailure>
  }
>()("@smthrs/mvp/repo/RepoReader") {}

/** Where `repo/about` reads what GitHub says of a repository: on the device, RepoApi's about route. */
export class AboutReader extends Context.Service<
  AboutReader,
  { readonly about: (owner: string, name: string) => Effect.Effect<About, ReadFailure> }
>()("@smthrs/mvp/repo/AboutReader") {}

/** How long a read keeps trying while Code Storage is busy: 1 s doubling to 15 s, for at most 2 minutes. */
export const READ_RETRY = RetryPolicy.make({
  initialMs: 1_000,
  factor: 2,
  maxMs: 15_000,
  expirationMs: 2 * 60_000,
  nonRetryable: ["@smthrs/mvp/repo/RepoNotFound", "@smthrs/mvp/repo/RepoReadsPaused"],
})

const treePayload = { repo: RepoName, revision: Revision }
const readPayload = { repo: RepoName, revision: Revision, path: FilePath }
const refsPayload = { repo: RepoName }

/** The step: list the files. */
export const ReadTree = Action.make("repo/ReadTree", {
  payload: treePayload,
  success: TreeListing,
  error: ReadFailure,
  retryPolicy: READ_RETRY,
})

/** The step: read one file. */
export const ReadFile = Action.make("repo/ReadFile", {
  payload: readPayload,
  success: FileRead,
  error: ReadFailure,
  retryPolicy: READ_RETRY,
})

/** The step: list the branches and tags. */
export const ReadRefs = Action.make("repo/ReadRefs", {
  payload: refsPayload,
  success: Refs,
  error: ReadFailure,
  retryPolicy: READ_RETRY,
})

/** The step: what GitHub says of the repository. */
export const ReadAbout = Action.make("repo/ReadAbout", {
  payload: refsPayload,
  success: About,
  error: ReadFailure,
  retryPolicy: RetryPolicy.make({ initialMs: 1_000, factor: 1, maxMs: 1_000, maxAttempts: 1 }),
})

/**
 * `repo/about { repo }`: what GitHub says of a repository, cloned or not, for its page. A refusal that may pass (GitHub
 * or RepoApi busy, unreachable or rate limited) is tried again under `READ_RETRY`; none for a repository that isn't
 * there or a spent read budget.
 */
export const RepoAbout = Flow.make("repo/about", {
  description: "What GitHub says of a public repository (owner/name), cloned or not: description, topics, languages, " +
    "latest release, contributors, counts, newest commit, top folder and README.",
  modelInvocable: false,
  payload: refsPayload,
  success: About,
  error: ReadFailure,
  body: Node.capture({ action: ReadAbout.name }, (payload) => ReadAbout.call(payload)),
}).annotate(Flow.Placement, Placement.client())

/** `repo/tree { repo, revision }`: every file's path at a commit. */
export const RepoTree = Flow.make("repo/tree", {
  description: "List every file path of a cloned repository (owner/name) at a full commit SHA. Answers " +
    "{ paths, truncated }; truncated is true when the listing stopped before the end.",
  modelInvocable: true,
  payload: treePayload,
  success: TreeListing,
  error: ReadFailure,
  body: Node.capture({ action: ReadTree.name }, (payload) => ReadTree.call(payload)),
}).annotate(Flow.Placement, Placement.client())

/** `repo/read { repo, revision, path }`: one file at a commit. */
export const RepoRead = Flow.make("repo/read", {
  description: "Read one file of a cloned repository (owner/name) at a full commit SHA. Answers " +
    `{ state: "text", contents, size }, or { state, size } for a binary file or one over ${MAX_BLOB_BYTES} bytes.`,
  modelInvocable: true,
  payload: readPayload,
  success: FileRead,
  error: ReadFailure,
  body: Node.capture({ action: ReadFile.name }, (payload) => ReadFile.call(payload)),
}).annotate(Flow.Placement, Placement.client())

/** `repo/refs { repo }`: the default branch, its head commit, and every branch and tag with its commit. */
export const RepoRefs = Flow.make("repo/refs", {
  description: "List a cloned repository's (owner/name) branches and tags. Answers { defaultBranch, head, branches, " +
    "tags, truncated }: head is the default branch's commit SHA, and each branch and tag is { name, sha }. Read at a " +
    "branch with its sha in repo/tree and repo/read; open one with app/navigate at /<owner>/<repo>/tree/<name>. A " +
    "repository not cloned here fails: say so, and clone it only when the person asks for that.",
  modelInvocable: true,
  payload: refsPayload,
  success: Refs,
  error: ReadFailure,
  body: Node.capture({ action: ReadRefs.name }, (payload) => ReadRefs.call(payload)),
}).annotate(Flow.Placement, Placement.client())

/** A line of a file, 1-based. */
export const Line = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999 }))

/** What `repo/copy` takes: the repository, what to copy, and the location it is copied from. */
export const copyPayload = {
  repo: RepoName,
  what: Schema.Literals(COPY_KINDS),
  revision: Schema.optional(Revision),
  path: Schema.optional(FilePath),
  kind: Schema.optional(Schema.Literals(["tree", "blob"])),
  line: Schema.optional(Line),
  lineEnd: Schema.optional(Line),
}

/** What `repo/copy` answers: whether the tab that asked has it on its clipboard. */
export const Copied = Schema.Struct({ copied: Schema.Boolean })
export type Copied = typeof Copied.Type

/**
 * There is nothing to copy: a permalink or the contents without a `revision`, the path or the contents without a
 * `path` (`invalid`), or contents that aren't text: a binary file or one over `MAX_BLOB_BYTES` (`not_text`).
 */
export class RepoCopyRefused extends Schema.TaggedError<RepoCopyRefused>()("@smthrs/mvp/repo/RepoCopyRefused", {
  reason: Schema.Literals(["invalid", "not_text"]),
}) {}

/** What a copy can fail with: nothing to copy, or the file couldn't be read. */
export const CopyFailure = Schema.Union([RepoCopyRefused, RepoNotFound, RepoReadsPaused, RepoReadUnavailable])
export type CopyFailure = typeof CopyFailure.Type

/**
 * One attempt, no retry: for a step a person is waiting on, who answers a failure with Try again. A copy that landed
 * minutes later would overwrite what they copied since; a clone RepoApi couldn't take shows why at once.
 */
export const ONCE = RetryPolicy.make({ initialMs: 1_000, factor: 1, maxMs: 1_000, maxAttempts: 1 })

/** The step: work out the text and write it to the asking tab's clipboard. */
export const CopyText = Action.make("repo/copy/write", {
  payload: copyPayload,
  success: Copied,
  error: CopyFailure,
  retryPolicy: ONCE,
})

/** `repo/copy { repo, what, revision?, path?, kind?, line?, lineEnd? }`: puts what a Copy button copies on the clipboard. */
export const RepoCopy = Flow.make("repo/copy", {
  description: "Copy to the clipboard of the person's tab. what: permalink (the app link to path at revision, a full " +
    "SHA; kind tree for a directory, else blob; line and lineEnd add ?L=), path, contents (the text of the file at " +
    "path and revision), or clone-url (the URL git clone takes). Answers { copied }: false when the tab has closed " +
    "or its clipboard refused. RepoCopyRefused when a needed revision or path is missing, or the file isn't text.",
  modelInvocable: true,
  payload: copyPayload,
  success: Copied,
  error: CopyFailure,
  body: Node.capture({ action: CopyText.name }, (payload) => CopyText.call(payload)),
}).annotate(Flow.Placement, Placement.client())

/**
 * RepoApi refused the clone: signed out (`sign_in`), not a Member or above (`forbidden`), `REPO_MAX_REPOSITORIES`
 * reached (`limit`), a name GitHub couldn't have (`invalid`), or no Code Storage organization (`not_configured`).
 */
export class RepoCloneRefused extends Schema.TaggedError<RepoCloneRefused>()("@smthrs/mvp/repo/RepoCloneRefused", {
  reason: Schema.Literals(["sign_in", "forbidden", "limit", "invalid", "not_configured"]),
}) {}

/** RepoApi couldn't take the clone now: unreachable, or Postgres, sign-in or the Durable Object didn't answer. */
export class RepoCloneUnavailable extends Schema.TaggedError<RepoCloneUnavailable>()(
  "@smthrs/mvp/repo/RepoCloneUnavailable",
  {},
) {}

/** What a clone request can fail with. */
export const CloneFailure = Schema.Union([RepoCloneRefused, RepoCloneUnavailable])
export type CloneFailure = typeof CloneFailure.Type

const clonePayload = { repo: RepoName }

/** The step: ask RepoApi for the clone, which it persists and answers at once. */
export const RequestClone = Action.make("repo/clone/request", {
  payload: clonePayload,
  success: CloneAccepted,
  error: CloneFailure,
  retryPolicy: ONCE,
})

/**
 * How long a launch keeps trying while RepoApi or its Durable Object can't be reached: 1 s doubling to 15 s, for at
 * most 2 minutes. A refusal is final.
 */
export const LAUNCH_RETRY = RetryPolicy.make({
  initialMs: 1_000,
  factor: 2,
  maxMs: 15_000,
  expirationMs: 2 * 60_000,
  nonRetryable: ["@smthrs/mvp/repo/RepoCloneRefused"],
})

/**
 * The step: start the remote `repo/Clone` for the attempt the request persisted. Starting it again changes nothing, so
 * the engine tries it again after a failure, and again on this device's next boot after a crash.
 */
export const LaunchClone = Action.make("repo/clone/launch", {
  payload: { repo: RepoName, cloneId: Schema.String },
  success: CloneLaunched,
  error: CloneFailure,
  retryPolicy: LAUNCH_RETRY,
})

/** `repo/clone { repo }`: asks RepoApi to clone a public GitHub repository into Code Storage. */
export const RepoCloneRequest = Flow.make("repo/clone", {
  description: "Clone a public GitHub repository (owner/name) so it can be browsed and read. Needs a signed-in Member. " +
    "Answers { id, txid, attempt } when a clone started, or { id, txid: null, status } when it is already cloning or " +
    "ready. Cloning takes seconds to minutes; repo/refs answers once it is ready. Only when the person asks to clone " +
    "or import one: opening or showing a repository's page never needs it. " +
    "RepoCloneRefused says why it may not: sign_in, forbidden, limit, invalid or not_configured.",
  modelInvocable: true,
  payload: clonePayload,
  success: CloneAccepted,
  error: CloneFailure,
  body: Node.capture({ request: RequestClone.name, launch: LaunchClone.name }, (payload) =>
    RequestClone.call(payload).pipe(
      // The request's answer is the flow's: the launch only starts what it persisted.
      Node.bindPlanned(Node.capture({ launch: LaunchClone.name }, (accepted) =>
        LaunchClone.call({ repo: payload.repo, cloneId: accepted.cloneId }).pipe(Node.andThen(Node.succeed(accepted))))),
    )),
}).annotate(Flow.Placement, Placement.client())

/** `owner/name` as its two parts; `RepoName` has checked it. */
export const parts = (repo: string): readonly [string, string] => {
  const [owner, name] = repo.split("/") as [string, string]
  return [owner, name]
}

/** Registers the read flows, reading through the host's `RepoReader` and, for `repo/about`, its `AboutReader`. */
export const registration = Layer.mergeAll(
  Interpreter.layerWithImplementations(
    RepoAbout,
    ReadAbout.toLayer(({ repo }) => {
      const [owner, name] = parts(repo)
      return AboutReader.use((reader) => reader.about(owner, name))
    }),
  ),
  Interpreter.layerWithImplementations(
    RepoTree,
    ReadTree.toLayer(({ repo, revision }) => {
      const [owner, name] = parts(repo)
      return RepoReader.use((reader) => reader.tree(owner, name, revision))
    }),
  ),
  Interpreter.layerWithImplementations(
    RepoRead,
    ReadFile.toLayer(({ repo, revision, path }) => {
      const [owner, name] = parts(repo)
      return RepoReader.use((reader) => reader.read(owner, name, revision, path))
    }),
  ),
  Interpreter.layerWithImplementations(
    RepoRefs,
    ReadRefs.toLayer(({ repo }) => {
      const [owner, name] = parts(repo)
      return RepoReader.use((reader) => reader.refs(owner, name))
    }),
  ),
)
