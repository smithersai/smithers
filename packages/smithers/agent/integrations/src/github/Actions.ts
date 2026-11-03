/**
 * The durable GitHub actions.
 *
 * {@link GitHubClient} is the host layer: it knows rate limits, pagination,
 * and token hygiene, and it is an ordinary Effect service. An `Action` is what
 * makes one of its calls a step of a durable flow, so a plan can name it, the
 * journal can record its result, and a restart replays it instead of posting
 * a second comment.
 *
 * Each action is declared here and implemented by {@link layer}. A flow body
 * calls `CommentOnIssue.call(...)`, which records a plan node and nothing
 * else; the layer is what a composition provides to make that node runnable.
 *
 * The write-back actions ({@link AddLabels}, {@link UpsertComment},
 * {@link CheckRun}, {@link LinkPullRequest}) read before they write. Each looks
 * for what an earlier attempt may already have done — a label already on the
 * issue, a comment carrying its key, a check run under its external id, a
 * closing reference already linked to the pull request — and only writes what is
 * missing. That makes a repeat safe, so they declare an `idempotencyKey` and a
 * bounded {@link retryPolicy}: a rate limit, a write whose answer was lost, or
 * a process that died mid-step, is resumed by repeating the step, and the
 * repeat finds its own work instead of doing it twice. The policy is the only
 * retry: the client underneath makes one request per call. They stay
 * `irreversible`, because a reader sees the change the moment GitHub accepts
 * it.
 *
 * **Whose object it is.** A sticky comment and a check run are found by a
 * key. Leave `key` out and the action keys the object by the running
 * execution ({@link runKey}): one sticky comment per run on an issue, one
 * check run per run and name on a commit, and a new run never takes over an
 * old run's. Pass `key` only for a domain key a flow chose and recorded before
 * the write, such as a dashboard comment every run of a schedule edits; never
 * derive it from what is written.
 *
 * Same-key reads and writes are serialized within this process, including
 * across separately built action layers. Separate processes must route a key
 * to one owner. The limit: GitHub enforces neither the comment marker nor a check run's
 * `external_id` as unique. A write still in flight at GitHub when the repeat
 * reads can land after it, and then both exist. The engine's backoff and a
 * restart's delay make that window narrow, not closed; an upsert then edits the
 * oldest match.
 *
 * @since 1.0.0
 */

import { Action, FlowRuntime, type RetryPolicy } from "@smthrs/flow"
import { Effect, Layer, Option, Schema } from "effect"
import { Failure, fromIntegrationError, retryPolicy as stepRetryPolicy } from "../core/ActionFailure.ts"
import { IntegrationError } from "../core/IntegrationError.ts"
import { GitHubClient } from "./GitHubClient.ts"
import { withWriteLock } from "./internal/WriteLock.ts"
import { IssueNumber, Owner, Repo, requireRepositoryPath } from "./Repository.ts"

/**
 * What {@link CommentOnIssue} needs.
 *
 * `issueNumber` is GitHub's issue or pull-request number. GitHub numbers both
 * in one sequence, so the same action comments on either.
 *
 * The three coordinates are validated rather than merely encoded, because they
 * become the request path and `new URL` resolves `..` inside one. A payload
 * built from a webhook body or a model's output therefore cannot walk the
 * token-bearing POST to another GitHub endpoint: it fails to decode.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CommentOnIssuePayload = Schema.Struct({
  owner: Owner,
  repo: Repo,
  issueNumber: IssueNumber,
  body: Schema.String
})

/**
 * The comment GitHub created.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Comment = Schema.Struct({
  id: Schema.Number,
  url: Schema.String
})

/**
 * Posts a comment on an issue or pull request.
 *
 * The tier is `irreversible`: the comment is visible the moment GitHub
 * accepts it, and deleting it afterwards is a different call with a different
 * outcome, so the engine never retries this step and neither does the client:
 * a 5xx or a dropped connection on the POST fails an `IntegrationFailure` with
 * `outcomeUnknown` rather than posting a second comment. A rate limit fails a
 * `RetryableIntegrationFailure` with the server's `retryAfterMillis`: nothing
 * was posted, so a flow may call again once that wait has passed. For a comment
 * the engine retries on its own, use {@link UpsertComment}.
 *
 * @category actions
 * @since 1.0.0
 */
export const CommentOnIssue = Action.make("integrations/github/comment-on-issue", {
  payload: CommentOnIssuePayload,
  success: Comment,
  error: Failure,
  tier: "irreversible"
})

/**
 * Implements {@link CommentOnIssue} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerCommentOnIssue: Layer.Layer<
  Action.Requirement<"integrations/github/comment-on-issue">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = CommentOnIssue.toLayer((payload) =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(payload.owner, payload.repo)
    return yield* client.request(
      "POST",
      `/repos/${repository}/issues/${payload.issueNumber}/comments`,
      { body: payload.body },
      { schema: Comment }
    )
  }).pipe(Effect.mapError(fromIntegrationError))
)

/**
 * The engine retry policy of the write-back actions, and the only retry a
 * GitHub write gets: the client itself never repeats a request. It is
 * `Core.ActionFailure.retryPolicy`.
 *
 * At most three attempts, so one write reaches GitHub at most three times.
 * Between attempts the engine waits half a second, then a second, or the wait
 * the server named in `retryAfterMillis` (its `Retry-After`, up to a minute).
 * A failure the client classified as final, an `IntegrationFailure`, is never
 * repeated. Each attempt reads before it writes, so a repeat after a lost
 * answer finds the first attempt's work rather than doing it again. The
 * attempt count is durable, so a process that dies between attempts resumes on
 * the next one.
 *
 * @category constants
 * @since 1.0.0
 */
export const retryPolicy: RetryPolicy.RetryPolicy = stepRetryPolicy

// A write-back step reads before it writes, so a write whose answer was lost
// is safe to repeat at the step even though the request alone is not.
const reconciled = (error: unknown): Failure => fromIntegrationError(error, { reconciles: true })

/**
 * How many pages of 100 a reconciling read walks before it gives up.
 *
 * @category constants
 * @since 1.0.0
 */
export const RECONCILE_PAGES = 10

const refused = (operation: string, message: string): IntegrationError =>
  new IntegrationError("delivery-failed", message, { operation, retryable: false, outcomeUnknown: false })

const decodeItems = <A>(
  schema: Schema.Codec<A>,
  items: ReadonlyArray<unknown>,
  operation: string
): Effect.Effect<ReadonlyArray<A>, IntegrationError> =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(items).pipe(
    // Do not attach the schema error: it can quote private provider content.
    Effect.mapError(() =>
      new IntegrationError("decode-failed", "GitHub reconciliation records failed schema validation.", {
        operation,
        retryable: false,
        outcomeUnknown: false
      })
    )
  )

/**
 * A GitHub label name.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LabelName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50))

/**
 * What {@link AddLabels} needs.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AddLabelsPayload = Schema.Struct({
  owner: Owner,
  repo: Repo,
  issueNumber: IssueNumber,
  labels: Schema.NonEmptyArray(LabelName)
})

/**
 * What {@link AddLabels} reports: the labels it added, and every label the
 * issue carries afterwards. `added` is empty when an earlier attempt already
 * added them all.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LabelsAdded = Schema.Struct({
  added: Schema.Array(Schema.String),
  labels: Schema.Array(Schema.String)
})

/**
 * Adds labels to an issue or pull request, keeping the ones it has.
 *
 * GitHub compares label names without case, and so does the check for the
 * labels already present.
 *
 * @category actions
 * @since 1.0.0
 */
export const AddLabels = Action.make("integrations/github/add-labels", {
  payload: AddLabelsPayload,
  success: LabelsAdded,
  error: Failure,
  tier: "irreversible",
  implementationVersion: "github/add-labels/v1",
  idempotencyKey: (payload) => ({
    action: "integrations/github/add-labels",
    owner: payload.owner,
    repo: payload.repo,
    issueNumber: payload.issueNumber,
    labels: [...payload.labels]
  }),
  retryPolicy
})

const Label = Schema.Struct({ name: Schema.String })

/**
 * Implements {@link AddLabels} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerAddLabels: Layer.Layer<
  Action.Requirement<"integrations/github/add-labels">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = AddLabels.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* GitHubClient
      const repository = yield* requireRepositoryPath(payload.owner, payload.repo)
      const path = `/repos/${repository}/issues/${payload.issueNumber}/labels`
      const page = yield* client.paginate(path, { maxPages: RECONCILE_PAGES })
      const current = (yield* decodeItems(Label, page.items, "add-labels")).map((label) => label.name)
      const present = new Set(current.map((name) => name.toLowerCase()))
      const missing = [...new Set(payload.labels)].filter((name) => !present.has(name.toLowerCase()))
      if (missing.length === 0) return { added: [], labels: current }
      const labels = yield* client.request("POST", path, { labels: missing }, { schema: Schema.Array(Label) })
      return { added: missing, labels: labels.map((label) => label.name) }
    }).pipe(Effect.mapError(reconciled)),
  { implementationVersion: "github/add-labels/v1" }
)

/**
 * The name a sticky comment is found by: letters, digits and `._:/-`, such as
 * a run id.
 *
 * @category schemas
 * @since 1.0.0
 */
export const StickyKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:/-]{1,200}$/))

/**
 * The key {@link UpsertComment} and {@link CheckRun} write under when the
 * payload names none: `run:` and the first 32 hex digits of SHA-256 over the
 * running execution's id. Every step of one run derives the same key, and
 * another run derives another; the execution id itself never reaches GitHub.
 * Dies with `Action.EffectKeyUnavailable` outside a flow execution.
 *
 * @category idempotency
 * @since 1.0.0
 */
export const runKey = (action: string): Effect.Effect<string> =>
  Effect.gen(function*() {
    const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
    if (Option.isNone(instance)) {
      return yield* Effect.die(
        new Action.EffectKeyUnavailable({
          name: action,
          message: `${action} ran outside a flow execution with no key. Without one it keys its object by the ` +
            "running execution, so it runs only inside an action implementation, or under a key the caller recorded."
        })
      )
    }
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(`smithers/run-key/v1\n${instance.value.executionId}`))
    )
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    return `run:${hex.slice(0, 32)}`
  })

/**
 * The hidden first line that marks a sticky comment as `key`'s.
 *
 * @category constructors
 * @since 1.0.0
 */
export const stickyMarker = (key: string): string => `<!-- smithers:key=${key} -->`

/**
 * What {@link UpsertComment} needs.
 *
 * `key` names the comment. Leave it out to keep one comment per run: every
 * upsert of one execution edits the same comment ({@link runKey}). Name one
 * only for a domain key chosen and recorded before the write, never derived
 * from what is written; every upsert under it, in any run, edits that comment.
 * `author` identifies the token’s user login or installation App id; comments
 * from other identities are never adopted.
 *
 * @category schemas
 * @since 1.0.0
 */
export const UpsertCommentPayload = Schema.Struct({
  owner: Owner,
  repo: Repo,
  issueNumber: IssueNumber,
  key: Schema.optionalKey(StickyKey),
  body: Schema.String,
  author: Schema.Union([
    Schema.Struct({ login: Schema.String.check(Schema.isMinLength(1)) }),
    Schema.Struct({ appId: Schema.Int.check(Schema.isGreaterThan(0)) })
  ])
})

/**
 * What {@link UpsertComment} did to the comment.
 *
 * @category schemas
 * @since 1.0.0
 */
export const UpsertOutcome = Schema.Literals(["created", "updated", "unchanged"])

/**
 * The sticky comment, and what the step did to it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const StickyComment = Schema.Struct({
  id: Schema.Number,
  url: Schema.String,
  outcome: UpsertOutcome
})

/**
 * Creates or edits the one comment `key` names on an issue or pull request,
 * or, with no `key`, the one comment of the running execution.
 *
 * The comment's first line is {@link stickyMarker}, which GitHub renders as
 * nothing. The action looks for it among the thread's comments, then edits
 * that comment, leaves it alone when it already reads as asked, or posts it.
 * A thread longer than {@link RECONCILE_PAGES} pages fails rather than risk a
 * second comment.
 *
 * @category actions
 * @since 1.0.0
 */
export const UpsertComment = Action.make("integrations/github/upsert-comment", {
  payload: UpsertCommentPayload,
  success: StickyComment,
  error: Failure,
  tier: "irreversible",
  implementationVersion: "github/upsert-comment/v3",
  idempotencyKey: (payload) => ({
    action: "integrations/github/upsert-comment",
    owner: payload.owner,
    repo: payload.repo,
    issueNumber: payload.issueNumber,
    key: payload.key ?? null,
    body: payload.body
  }),
  retryPolicy
})

const ListedComment = Schema.Struct({
  id: Schema.Number,
  url: Schema.String,
  body: Schema.optional(Schema.String),
  user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String, type: Schema.String }))),
  performed_via_github_app: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.Number })))
})

/**
 * Implements {@link UpsertComment} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerUpsertComment: Layer.Layer<
  Action.Requirement<"integrations/github/upsert-comment">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = UpsertComment.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* GitHubClient
      const repository = yield* requireRepositoryPath(payload.owner, payload.repo)
      const marker = stickyMarker(payload.key ?? (yield* runKey(UpsertComment.name)))
      return yield* withWriteLock(
        JSON.stringify(["comment", repository.toLowerCase(), payload.issueNumber, marker]),
        Effect.gen(function*() {
          const body = `${marker}\n${payload.body}`
          const page = yield* client.paginate(`/repos/${repository}/issues/${payload.issueNumber}/comments`, {
            maxPages: RECONCILE_PAGES
          })
          // github.com's editor saves CRLF line ends, so a comment a person edited
          // still starts with the marker, followed by `\r\n`.
          const existing = (yield* decodeItems(ListedComment, page.items, "upsert-comment")).find((comment) =>
            comment.body?.split("\n", 1)[0]?.replace(/\r$/, "") === marker &&
            ("login" in payload.author
              ? comment.user?.login.toLowerCase() === payload.author.login.toLowerCase()
              : comment.user?.type === "Bot" && comment.performed_via_github_app?.id === payload.author.appId)
          )
          if (existing === undefined && page.truncated) {
            return yield* Effect.fail(
              refused(
                "upsert-comment",
                `Issue ${payload.issueNumber} has more comments than ${RECONCILE_PAGES} pages; the sticky comment was not looked for further.`
              )
            )
          }
          if (existing === undefined) {
            const created = yield* client.request(
              "POST",
              `/repos/${repository}/issues/${payload.issueNumber}/comments`,
              { body },
              { schema: Comment }
            )
            return { ...created, outcome: "created" as const }
          }
          if (existing.body === body) return { id: existing.id, url: existing.url, outcome: "unchanged" as const }
          const updated = yield* client.request(
            "PATCH",
            `/repos/${repository}/issues/comments/${existing.id}`,
            { body },
            { schema: Comment }
          )
          return { ...updated, outcome: "updated" as const }
        })
      )
    }).pipe(Effect.mapError(reconciled)),
  { implementationVersion: "github/upsert-comment/v3" }
)

/**
 * A commit SHA, SHA-1 or SHA-256, in lowercase hex.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CommitSha = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))

/**
 * A check run's `output`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CheckRunOutput = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  text: Schema.optionalKey(Schema.String)
})

/**
 * What {@link CheckRun} needs.
 *
 * `key` becomes the check run's `external_id`, which is how a repeat finds
 * it. Leave it out to keep one check run per run and name: every call of one
 * execution updates the same run ({@link runKey}). Name one only for a domain
 * key chosen and recorded before the write, never derived from what is
 * written. A flow reports progress by calling again with a new `status`;
 * `conclusion` is required once `status` is `completed`. `appId` is the
 * authenticated App's numeric id; a run from another App is never adopted.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CheckRunPayload = Schema.Struct({
  owner: Owner,
  repo: Repo,
  appId: Schema.Int.check(Schema.isGreaterThan(0)),
  headSha: CommitSha,
  name: Schema.String.check(Schema.isMinLength(1)),
  key: Schema.optionalKey(StickyKey),
  status: Schema.optionalKey(Schema.Literals(["queued", "in_progress", "completed"])),
  conclusion: Schema.optionalKey(
    Schema.Literals(["action_required", "cancelled", "failure", "neutral", "success", "skipped", "timed_out"])
  ),
  detailsUrl: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(CheckRunOutput)
})

/**
 * The check run as GitHub left it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CheckRunReceipt = Schema.Struct({
  id: Schema.Number,
  url: Schema.NullOr(Schema.String),
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  created: Schema.Boolean
})

/**
 * Creates or updates the check run `key` names on a commit, or, with no `key`,
 * the running execution's check run of that name.
 *
 * Writing check runs needs a GitHub App installation token; GitHub refuses a
 * personal token with 403.
 *
 * @category actions
 * @since 1.0.0
 */
export const CheckRun = Action.make("integrations/github/check-run", {
  payload: CheckRunPayload,
  success: CheckRunReceipt,
  error: Failure,
  tier: "irreversible",
  implementationVersion: "github/check-run/v4",
  idempotencyKey: (payload) => ({
    action: "integrations/github/check-run",
    ...(payload as unknown as Record<string, Schema.Json>)
  }),
  retryPolicy
})

const ListedCheckRun = Schema.Struct({
  id: Schema.Number,
  app: Schema.Struct({ id: Schema.Int.check(Schema.isGreaterThan(0)) }),
  external_id: Schema.NullOr(Schema.String),
  html_url: Schema.NullOr(Schema.String),
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String)
})

const CheckRuns = Schema.Struct({ total_count: Schema.Number, check_runs: Schema.Array(Schema.Unknown) })

/**
 * Implements {@link CheckRun} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerCheckRun: Layer.Layer<
  Action.Requirement<"integrations/github/check-run">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = CheckRun.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* GitHubClient
      const repository = yield* requireRepositoryPath(payload.owner, payload.repo)
      const key = payload.key ?? (yield* runKey(CheckRun.name))
      return yield* withWriteLock(
        JSON.stringify(["check-run", repository.toLowerCase(), payload.headSha, payload.name, payload.appId, key]),
        Effect.gen(function*() {
          const listed = yield* client.request(
            "GET",
            `/repos/${repository}/commits/${payload.headSha}/check-runs`,
            undefined,
            {
              query: { check_name: payload.name, filter: "all", per_page: 100 },
              schema: CheckRuns
            }
          )
          const runs = yield* decodeItems(ListedCheckRun, listed.check_runs, "check-run")
          const existing = runs.find((run) => run.external_id === key && run.app.id === payload.appId)
          if (existing === undefined && listed.total_count > listed.check_runs.length) {
            return yield* Effect.fail(
              refused("check-run", `Commit ${payload.headSha} has more than 100 "${payload.name}" check runs.`)
            )
          }
          const fields = {
            name: payload.name,
            external_id: key,
            ...(payload.status === undefined ? {} : { status: payload.status }),
            ...(payload.conclusion === undefined ? {} : { conclusion: payload.conclusion }),
            ...(payload.detailsUrl === undefined ? {} : { details_url: payload.detailsUrl }),
            ...(payload.output === undefined ? {} : { output: payload.output })
          }
          const written = existing === undefined
            ? yield* client.request(
              "POST",
              `/repos/${repository}/check-runs`,
              { ...fields, head_sha: payload.headSha },
              {
                schema: ListedCheckRun
              }
            )
            : yield* client.request("PATCH", `/repos/${repository}/check-runs/${existing.id}`, fields, {
              schema: ListedCheckRun
            })
          return {
            id: written.id,
            url: written.html_url,
            status: written.status,
            conclusion: written.conclusion,
            created: existing === undefined
          }
        })
      )
    }).pipe(Effect.mapError(reconciled)),
  { implementationVersion: "github/check-run/v4" }
)

/**
 * What {@link LinkPullRequest} needs.
 *
 * The issue is in the pull request's repository unless `issueOwner` and
 * `issueRepo` name another.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LinkPullRequestPayload = Schema.Struct({
  owner: Owner,
  repo: Repo,
  pullNumber: IssueNumber,
  issueNumber: IssueNumber,
  issueOwner: Schema.optionalKey(Owner),
  issueRepo: Schema.optionalKey(Repo)
})

/**
 * The pull request, the reference it carries, and whether the step added it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PullRequestLinked = Schema.Struct({
  pullNumber: Schema.Number,
  url: Schema.String,
  reference: Schema.String,
  updated: Schema.Boolean
})

/**
 * Links a pull request to the issue it resolves.
 *
 * Uses GitHub's closing-reference mutation, leaving the description intact.
 * Existing closing keywords and manually linked references are left alone.
 * A server without the mutation fails without rewriting the description.
 *
 * @category actions
 * @since 1.0.0
 */
export const LinkPullRequest = Action.make("integrations/github/link-pr", {
  payload: LinkPullRequestPayload,
  success: PullRequestLinked,
  error: Failure,
  tier: "irreversible",
  implementationVersion: "github/link-pr/v3",
  idempotencyKey: (payload) => ({
    action: "integrations/github/link-pr",
    owner: payload.owner,
    repo: payload.repo,
    pullNumber: payload.pullNumber,
    issueNumber: payload.issueNumber,
    issueOwner: payload.issueOwner ?? payload.owner,
    issueRepo: payload.issueRepo ?? payload.repo
  }),
  retryPolicy
})

const PullRequest = Schema.Struct({ html_url: Schema.String })

const NodeId = Schema.Struct({ id: Schema.NonEmptyString })
const LinkTargets = Schema.Struct({
  data: Schema.Struct({
    pullRepository: Schema.Struct({
      pullRequest: Schema.Struct({
        id: Schema.NonEmptyString,
        closingIssuesReferences: Schema.Struct({
          nodes: Schema.Array(NodeId),
          pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean })
        })
      })
    }),
    issueRepository: Schema.Struct({ issue: NodeId })
  }),
  errors: Schema.optionalKey(Schema.Array(Schema.Unknown))
})
const decodeLinked = Schema.decodeUnknownOption(Schema.Struct({
  data: Schema.Struct({ addCloseIssueReferences: Schema.Struct({ issue: NodeId }) }),
  errors: Schema.optionalKey(Schema.Array(Schema.Unknown))
}))

/**
 * Implements {@link LinkPullRequest} over the client in context.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerLinkPullRequest: Layer.Layer<
  Action.Requirement<"integrations/github/link-pr">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = LinkPullRequest.toLayer(
  (payload) =>
    Effect.gen(function*() {
      const client = yield* GitHubClient
      const repository = yield* requireRepositoryPath(payload.owner, payload.repo)
      const issueOwner = payload.issueOwner ?? payload.owner
      const issueRepo = payload.issueRepo ?? payload.repo
      yield* requireRepositoryPath(issueOwner, issueRepo)
      const sameRepository = issueOwner.toLowerCase() === payload.owner.toLowerCase() &&
        issueRepo.toLowerCase() === payload.repo.toLowerCase()
      const reference = sameRepository
        ? `#${payload.issueNumber}`
        : `${issueOwner}/${issueRepo}#${payload.issueNumber}`
      const path = `/repos/${repository}/pulls/${payload.pullNumber}`
      const pull = yield* client.request("GET", path, undefined, { schema: PullRequest })
      const linked = { pullNumber: payload.pullNumber, url: pull.html_url, reference }
      // GitHub does not support conditional PATCH here. A second body read
      // would still race with a person's edit; link the objects instead.
      const targets = yield* client.request("POST", "/graphql", {
        query:
          "query($owner: String!, $repo: String!, $pull: Int!, $issueOwner: String!, $issueRepo: String!, $issue: Int!) { " +
          "pullRepository: repository(owner: $owner, name: $repo) { pullRequest(number: $pull) { id " +
          "closingIssuesReferences(first: 100) { nodes { id } pageInfo { hasNextPage } } } } " +
          "issueRepository: repository(owner: $issueOwner, name: $issueRepo) { issue(number: $issue) { id } } }",
        variables: {
          owner: payload.owner,
          repo: payload.repo,
          pull: payload.pullNumber,
          issueOwner,
          issueRepo,
          issue: payload.issueNumber
        }
      }, { schema: LinkTargets, retryUnsafeWrites: true })
      if (targets.errors !== undefined && targets.errors.length > 0) {
        return yield* Effect.fail(refused("link-pr", "GitHub refused to read the closing references."))
      }
      const targetPull = targets.data.pullRepository.pullRequest
      const issueId = targets.data.issueRepository.issue.id
      if (targetPull.closingIssuesReferences.nodes.some((issue) => issue.id === issueId)) {
        return { ...linked, updated: false }
      }
      if (targetPull.closingIssuesReferences.pageInfo.hasNextPage) {
        return yield* Effect.fail(refused("link-pr", "The pull request has more than 100 closing references."))
      }
      const answer = yield* client.request("POST", "/graphql", {
        query:
          "mutation($input: AddCloseIssueReferencesInput!) { addCloseIssueReferences(input: $input) { issue { id } } }",
        variables: { input: { issueId, pullRequestIds: [targetPull.id] } }
      })
      const decoded = decodeLinked(answer)
      if (
        Option.isNone(decoded) || (decoded.value.errors?.length ?? 0) > 0 ||
        decoded.value.data.addCloseIssueReferences.issue.id !== issueId
      ) {
        return yield* Effect.fail(
          new IntegrationError("decode-failed", "GitHub did not confirm the closing reference.", {
            operation: "link-pr",
            retryable: false,
            outcomeUnknown: true
          })
        )
      }
      return { ...linked, updated: true }
    }).pipe(Effect.mapError(reconciled)),
  { implementationVersion: "github/link-pr/v3" }
)

/**
 * Every GitHub action's implementation, in one layer.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<
  | Action.Requirement<"integrations/github/comment-on-issue">
  | Action.Requirement<"integrations/github/add-labels">
  | Action.Requirement<"integrations/github/upsert-comment">
  | Action.Requirement<"integrations/github/check-run">
  | Action.Requirement<"integrations/github/link-pr">,
  never,
  GitHubClient | FlowRuntime.FlowRuntime
> = Layer.mergeAll(layerCommentOnIssue, layerAddLabels, layerUpsertComment, layerCheckRun, layerLinkPullRequest)
