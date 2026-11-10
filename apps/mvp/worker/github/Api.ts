import * as WriteAuthority from "../WriteAuthority.ts"
import { itemShape } from "./ItemShape.ts"
import * as MirrorRefresh from "../MirrorRefresh.ts"
import { COMMITMENTS } from "../../src/features/issues/lifecycle.ts"
import { digestSync } from "@smthrs/crypto"
import { ShapeProxy } from "@smthrs/effect-electric"
import { Core, GitHub } from "@smthrs/integrations"
import { Context, Cause, Clock, Duration, Effect, type Layer, Metric, Option, Redacted, Ref, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import { LOCAL_ELECTRIC_URL } from "../../src/features/chat/contract.ts"
import {
  applyExecutionId,
  issueNumberOf,
  itemId,
  COMMENT_COLUMNS,
  COMMENTS_SHAPE_ROUTE,
  COMMENTS_TABLE,
  GITHUB_WEBHOOK_ROUTE,
  ISSUES_STREAM,
  ITEM_COLUMNS,
  ITEMS_SHAPE_ROUTE,
  ITEM_SUMMARIES_SHAPE_ROUTE,
  ITEM_SUMMARY_COLUMNS,
  ITEMS_TABLE,
  ISSUE_EDGE_COLUMNS,
  ISSUE_EDGES_SHAPE_ROUTE,
  ISSUE_RELATIONS_TABLE,
  relationsExecutionId,
  MAX_BODY_LENGTH,
  MAX_REASON_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TRIAGE_DAILY_TOKENS,
  MAX_WEBHOOK_BYTES,
  MAX_WRITE_BYTES,
  DEFAULT_TRIAGE_DAILY_TOKENS,
  reconcileBucketStart,
  reconcileExecutionId,
  SYNC_COLUMNS,
  SYNC_SHAPE_ROUTE,
  SYNC_STALE_MS,
  SYNC_TABLE,
  TRIAGE_DECISIONS,
  TRIAGE_SETTINGS_COLUMNS,
  TRIAGE_SETTINGS_SHAPE_ROUTE,
  TRIAGE_SETTINGS_TABLE,
  triageRunExecutionId,
  WRITE_COLUMNS,
  writeExecutionId,
  type WriteVia,
  type WriteRefusal,
  WRITES_SEGMENT,
  WRITES_SHAPE_ROUTE,
  WRITES_TABLE,
} from "../../src/features/issues/contract.ts"
import { mayAsk } from "../../src/features/auth/contract.ts"
import { WORK_LINK_COLUMNS, WORK_LINKS_SHAPE_ROUTE, WORK_LINKS_TABLE } from "../../src/features/issues/work.ts"
import { TODO_LEAF_COLUMNS, TODO_LEAVES_SHAPE_ROUTE, TODO_LEAVES_TABLE } from "../../src/features/todos/leaves.ts"
import { ACTION_COLUMNS, ACTIONS_SHAPE_ROUTE } from "../../src/features/actions/contract.ts"
import {
  CHECK_COLUMNS,
  CHECKS_SHAPE_ROUTE,
  DEFAULT_MERGE_METHOD,
  MERGE_METHODS,
  mergeExecutionId,
  PULL_COLUMNS,
  PULL_COMMIT_COLUMNS,
  PULL_COMMITS_SHAPE_ROUTE,
  PULL_COMMITS_TABLE,
  PULLS_SHAPE_ROUTE,
  PULL_RECEIPT_HEADER,
  PULLS_TABLE,
  REVIEW_COLUMNS,
  REVIEWS_SHAPE_ROUTE,
  REVIEWS_TABLE,
  RUNS_TABLE,
  SHA,
} from "../../src/features/pulls/contract.ts"
import { isRepository, REPOS_ROUTE, repoId } from "../../src/features/repo/contract.ts"
import {
  publishExecutionId,
  resyncExecutionId,
  UPDATE_METHODS,
  updateExecutionId,
} from "../../src/features/branch/contract.ts"
import { branchAccess, branchAccessAs, canEdit } from "../branch/Access.ts"
import { Publish, publishBlocked, Resync, Update } from "../branch/Publish.ts"
import { type Actor, canAsk, refusesPersonOnly, Sessions } from "#vibelang/emitted/worker/Actor"
import { readBounded } from "#vibelang/emitted/worker/Body"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import * as PersonalStore from "../personal/Store.ts"
import * as Dispatch from "../ci/Dispatch.ts"
import { FlowStarter, StartUnavailable } from "#vibelang/emitted/worker/Flows"
import * as Notifications from "../Notifications.ts"
import * as ShapeAccess from "#vibelang/emitted/worker/ShapeAccess"
import { Apply, PULL_EVENTS } from "#vibelang/emitted/worker/github/Apply"
import * as Compare from "./Compare.ts"
import { statusOf } from "#vibelang/emitted/worker/github/Calls"
import { apiUrl, type GitHubApp, type Repository, repositoryOf } from "#vibelang/emitted/worker/github/Config"
import { Merge } from "./Merge.ts"
import * as FirstPaint from "./FirstPaint.ts"
import * as IssueList from "./IssueList.ts"
import * as Metrics from "#vibelang/emitted/worker/github/Metrics"
import * as MachineWrite from "./MachineWrite.ts"
import * as WorkLinks from "./WorkLinks.ts"
import { Reconcile } from "./Reconcile.ts"
import { Relations } from "./Relations.ts"
import * as TreeScope from "./TreeScope.ts"
import * as PullRefresh from "./PullRefresh.ts"
import * as ReadToken from "./ReadToken.ts"
import * as Visibility from "./Visibility.ts"
import * as RepoRoles from "./RepoRoles.ts"
import * as Review from "./Review.ts"
import * as Store from "./Store.ts"
import * as Access from "./Access.ts"
import { TriageRun } from "./Triage.ts"
import * as TriageStore from "./TriageStore.ts"
import { Write } from "./Write.ts"

// The git loop's routes in ChatApi (decision 0012 §2 and §4, docs/features/issues.md#routes):
// - `POST /api/github/webhook`: GitHub's webhook. Verified with `X-Hub-Signature-256` (`Core.Channel` from
//   `@smthrs/integrations`), it starts `github/Apply` for the issue it names, one execution per delivery, and records
//   the delivery; it never writes a row itself. A payload names a subject; it never sets state. With `REPO_FLOWS` on, a
//   push or a pull request also starts its `triggers/Dispatch` (worker/ci/Dispatch.ts).
// - `POST /api/repos/<owner>/<name>/writes`: the one door every git write goes through. It checks sign-in, the App,
//   the person's role on the repository the path names (`RepoRoles`, decision 0079), the bounds and the payload's
//   hash, records the write while that role holds, and starts `github/Write` keyed by the device's write id. The
//   settled row is the result; nothing waits on the remote run. Every write goes to any repository the deployment may
//   act on, at its minimum role there (decision 0079 slice 2).
// - `GET /api/shapes/{items,comments,github-sync}`: the synced repository's rows, each with its column list, for a
//   signed-in person with a role on it, or for anyone once GitHub said the repository is public. A read of `items`
//   that finds the sync older than 5 minutes starts `github/Reconcile`, once per repository and 5-minute bucket, and
//   waits at most `RECONCILE_START_TIMEOUT` for admission beside its own work.
// - `GET /api/shapes/github-writes`: the signed-in person's own writes, their status only.
// - Triage (§5): the writes route takes a person's Accept or Not accepted, Run triage again, and Enable and Pause, each
//   at its own minimum role; Run triage again and Enable also need a Member of the deployment's own repository, whose
//   model judges (ruling AUTH-8); `issues.opened` starts `triage/Run` while triage is on; and `GET
//   /api/shapes/triage-settings` serves whether it is.
// The webhook, the shapes and Reconcile serve every repository the deployment may act on (decision 0079, slice 1b):
// its own (`GITHUB_REPOSITORY`) and, with the App, any other `GITHUB_ALLOWED_REPOSITORIES` doesn't leave out. A shape
// names its repository with `?repo=<owner>/<name>`, its own unless it does; any other is `404 not_found`. Where the App
// isn't installed, Reconcile records `app_not_installed` on the repository's sync row, which the page reads to send
// people to GitHub instead.

const noStore = { "cache-control": "no-store" }

/** The shapes of one repository's rows, by route: each table, its columns, and its filter on `$1`, the repository's id. */
const REPOSITORY_SHAPES: Readonly<Record<string, { readonly table: string; readonly columns: ReadonlyArray<string>; readonly where: string }>> = {
  [ITEM_SUMMARIES_SHAPE_ROUTE]: { table: ITEMS_TABLE, columns: ITEM_SUMMARY_COLUMNS, where: "repo_id = $1" },
  [ITEMS_SHAPE_ROUTE]: { table: ITEMS_TABLE, columns: ITEM_COLUMNS, where: "repo_id = $1" },
  [COMMENTS_SHAPE_ROUTE]: { table: COMMENTS_TABLE, columns: COMMENT_COLUMNS, where: "repo_id = $1" },
  [SYNC_SHAPE_ROUTE]: { table: SYNC_TABLE, columns: SYNC_COLUMNS, where: "repo_id = $1" },
  [TRIAGE_SETTINGS_SHAPE_ROUTE]: { table: TRIAGE_SETTINGS_TABLE, columns: TRIAGE_SETTINGS_COLUMNS, where: "repo_id = $1" },
  // Pull requests (docs/features/pulls.md): their rows, commits and reviews.
  [PULLS_SHAPE_ROUTE]: { table: PULLS_TABLE, columns: PULL_COLUMNS, where: "repo_id = $1" },
  [PULL_COMMITS_SHAPE_ROUTE]: { table: PULL_COMMITS_TABLE, columns: PULL_COMMIT_COLUMNS, where: "repo_id = $1" },
  [REVIEWS_SHAPE_ROUTE]: { table: REVIEWS_TABLE, columns: REVIEW_COLUMNS, where: "repo_id = $1" },
  // A pull request's checks are its head's `checks/Run` rows; a repository flow's runs are the repository's runs
  // (docs/features/actions.md), whose states the Checks tab doesn't read.
  [CHECKS_SHAPE_ROUTE]: { table: RUNS_TABLE, columns: CHECK_COLUMNS, where: "repo_id = $1 AND sha IS NOT NULL AND execution IS NULL" },
  // What links each issue to the work on it (decision 0147, docs/features/work-links.md).
  [WORK_LINKS_SHAPE_ROUTE]: { table: WORK_LINKS_TABLE, columns: WORK_LINK_COLUMNS, where: "repo_id = $1" },
  // A TODO's leaf under its issue (decision 0153): state and validation only, read by whoever reads the issues.
  [TODO_LEAVES_SHAPE_ROUTE]: { table: TODO_LEAVES_TABLE, columns: TODO_LEAF_COLUMNS, where: "repo_id = $1" },
}

const refuse = (status: number, code: WriteRefusal | "not_configured" | "invalid_signature", retryAfterSeconds?: number) =>
  HttpServerResponse.jsonUnsafe({ code }, {
    status,
    headers: retryAfterSeconds === undefined ? noStore : { ...noStore, "retry-after": String(retryAfterSeconds) },
  })

/** No person's id: what a signed-out writes shape filters on, so it holds no rows. */
const NOBODY = ""

const WriteId = Schema.String.check(Schema.isUUID())
const Title = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= MAX_TITLE_LENGTH),
)
const IssueBody = Schema.String.check(Schema.isMaxLength(MAX_BODY_LENGTH))
const CommentBody = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= MAX_BODY_LENGTH),
)

const IssueNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }))
const Sha = Schema.String.check(Schema.isPattern(SHA))
const Reason = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= MAX_REASON_LENGTH),
)

/** A write as the device sends it. It names nobody: who acts is the session's or the run credential's to say. */
const WriteBody = Schema.Union([
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("issue/commitment"), number: IssueNumber, commitment: Schema.Literals(COMMITMENTS) }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("issue/create"), title: Title, body: IssueBody }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("issue/comment"), number: IssueNumber, body: CommentBody }),
  Schema.Struct({
    writeId: WriteId,
    op: Schema.Literal("issue/triage"),
    number: IssueNumber,
    decision: Schema.Literals(TRIAGE_DECISIONS),
    reason: Schema.optional(Reason),
  }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("triage/run"), number: IssueNumber }),
  Schema.Struct({
    writeId: WriteId,
    op: Schema.Literal("triage/enable"),
    dailyTokens: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_TRIAGE_DAILY_TOKENS }))),
  }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("triage/pause") }),
  Schema.Struct({
    writeId: WriteId,
    op: Schema.Literal("pr/merge"),
    number: IssueNumber,
    headSha: Sha,
    baseSha: Sha,
    method: Schema.optional(Schema.Literals(MERGE_METHODS)),
  }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("branch/publish"), branchId: WriteId, title: Title, body: IssueBody }),
  Schema.Struct({
    writeId: WriteId,
    op: Schema.Literal("branch/update"),
    branchId: WriteId,
    method: Schema.optional(Schema.Literals(UPDATE_METHODS)),
  }),
  Schema.Struct({ writeId: WriteId, op: Schema.Literal("branch/resync"), branchId: WriteId }),
])
type WriteBody = typeof WriteBody.Type

/**
 * Whether `who` may make `write` (decision 0007, decision 0012 §3): opening an issue and commenting are Guest acts;
 * overriding triage and Run triage again Member and above (`repo:triage`); enabling and pausing it Maintainer and above
 * (`repo:triage-flow`). Triage is the person's own act: the route refuses anyone acting for them first.
 */
const mayWrite = (who: Actor, write: WriteBody): boolean => {
  switch (write.op) {
    case "issue/create":
    case "issue/comment":
      return who.role !== null
    case "issue/triage":
    case "triage/run":
    // Publish, Update branch and Resync are a Member's (`repo:branch-create`), on a branch they may edit.
    case "branch/publish":
    case "branch/update":
    case "branch/resync":
      return canAsk(who)
    case "issue/commitment":
    case "triage/enable":
    case "triage/pause":
    // Merging's minimum is Maintainer (decision 0007 `repo:merge`, decision 0012 decision 6).
    case "pr/merge":
      return who.role === "admin" || who.role === "maintainer"
  }
}

/**
 * Who a write acts for, as the request says it, never its body (decision 0017 slice 0): the person in their own
 * session, or the agent through its run credential, whose write goes as the App.
 */
const viaOf = (who: Actor): WriteVia => (who.act === undefined ? "person" : "agent")

/** The writes that act on GitHub with the person's own token, so need their session. */
const withPersonToken = (write: WriteBody, via: WriteVia): boolean =>
  via === "person" &&
  (write.op === "issue/create" || write.op === "issue/comment" || write.op === "issue/triage" ||
    write.op === "issue/commitment" || write.op === "pr/merge" || write.op === "branch/publish" ||
    write.op === "branch/update" || write.op === "branch/resync")

/** A write's payload as it is recorded and hashed. */
const payloadOf = (write: WriteBody): Store.WritePayload => {
  switch (write.op) {
    case "issue/commitment":
      return { op: write.op, number: write.number, commitment: write.commitment }
    case "pr/merge":
      return {
        op: write.op,
        number: write.number,
        headSha: write.headSha,
        baseSha: write.baseSha,
        method: write.method ?? DEFAULT_MERGE_METHOD,
      }
    case "issue/create":
      return { op: write.op, title: write.title.trim(), body: write.body }
    case "issue/comment":
      return { op: write.op, number: write.number, body: write.body }
    case "issue/triage":
      return { op: write.op, number: write.number, decision: write.decision, reason: write.reason ?? null }
    case "triage/run":
      return { op: write.op, number: write.number }
    case "triage/enable":
      return { op: write.op, dailyTokens: write.dailyTokens ?? DEFAULT_TRIAGE_DAILY_TOKENS }
    case "triage/pause":
      return { op: write.op }
    case "branch/publish":
      return { op: write.op, branchId: write.branchId.toLowerCase(), title: write.title.trim(), body: write.body }
    case "branch/update":
      return { op: write.op, branchId: write.branchId.toLowerCase(), method: write.method ?? "merge" }
    case "branch/resync":
      return { op: write.op, branchId: write.branchId.toLowerCase() }
  }
}
const decodeWrite = Schema.decodeUnknownOption(Schema.fromJsonString(WriteBody))

/** `/api/repos/<owner>/<name>/writes` as its owner and name, or `undefined` for any other path. */
export const parseWritesPath = (path: string): { readonly owner: string; readonly name: string } | undefined => {
  if (!path.startsWith(`${REPOS_ROUTE}/`)) return undefined
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  if (segments.length !== 3 || segments[2] !== WRITES_SEGMENT) return undefined
  try {
    return { owner: decodeURIComponent(segments[0]!), name: decodeURIComponent(segments[1]!) }
  } catch {
    return undefined
  }
}

const SHAPES: ReadonlySet<string> = new Set([
  ITEM_SUMMARIES_SHAPE_ROUTE,
  ITEMS_SHAPE_ROUTE,
  COMMENTS_SHAPE_ROUTE,
  WRITES_SHAPE_ROUTE,
  SYNC_SHAPE_ROUTE,
  TRIAGE_SETTINGS_SHAPE_ROUTE,
  PULLS_SHAPE_ROUTE,
  PULL_COMMITS_SHAPE_ROUTE,
  REVIEWS_SHAPE_ROUTE,
  CHECKS_SHAPE_ROUTE,
  ACTIONS_SHAPE_ROUTE,
  WORK_LINKS_SHAPE_ROUTE,
  ISSUE_EDGES_SHAPE_ROUTE,
  TODO_LEAVES_SHAPE_ROUTE,
])

/** Whether ChatApi routes `path` here. */
/** `/api/repos/<owner>/<name>/writes/<id>` as its parts, or `undefined` for any other path. */
export const parseMachineWritePath = (path: string): { readonly owner: string; readonly name: string; readonly id: string; readonly retry: boolean } | undefined => {
  if (!path.startsWith(`${REPOS_ROUTE}/`)) return undefined
  const segments = path.slice(REPOS_ROUTE.length + 1).split("/")
  const retry = segments.length === 5 && segments[4] === "retry"
  if ((segments.length !== 4 && !retry) || segments[2] !== WRITES_SEGMENT || !/^[0-9a-f-]{36}$/i.test(segments[3]!)) return undefined
  try {
    return { owner: decodeURIComponent(segments[0]!), name: decodeURIComponent(segments[1]!), id: segments[3]!.toLowerCase(), retry }
  } catch {
    return undefined
  }
}

export const handles = (path: string): boolean =>
  path === GITHUB_WEBHOOK_ROUTE || SHAPES.has(path) || parseWritesPath(path) !== undefined || parseMachineWritePath(path) !== undefined ||
  Compare.parseComparePath(path) !== undefined || Review.parseReviewPath(path) !== undefined ||
  IssueList.parseIssuesPath(path) !== undefined || WorkLinks.parseLinksPath(path) !== undefined ||
  FirstPaint.parseFirstPaintPath(path) !== undefined || TreeScope.parseTreeScopePath(path) !== undefined

/**
 * How long a stale read of the issues waits for `github/Reconcile`'s start to be admitted: one idempotent Durable Object
 * call, keyed by the bucket's execution id. A slower admission is dropped with the read's answer, and the next stale
 * read asks again.
 */
export const RECONCILE_START_TIMEOUT = Duration.seconds(2)

/** The bounds of a delivery id: GitHub's are UUIDs; anything up to 128 characters is taken. */
const DELIVERY_ID = /^[A-Za-z0-9-]{1,128}$/

/** The subject a delivery names: the repository and issue of an `issues` or `issue_comment` event. */
const Subject = Schema.Struct({
  repository: Schema.Struct({ full_name: Schema.String }),
  issue: Schema.Struct({ number: Schema.Int }),
})
const decodeSubject = Schema.decodeUnknownOption(Subject)

/** The subject of a `pull_request` or `pull_request_review` event: the repository and pull request. */
const PullSubject = Schema.Struct({
  repository: Schema.Struct({ full_name: Schema.String }),
  pull_request: Schema.Struct({ number: Schema.Int }),
})
const decodePullSubject = Schema.decodeUnknownOption(PullSubject)

/**
 * A `sub_issues` delivery (https://docs.github.com/en/webhooks/webhook-events-and-payloads#sub_issues). `parent_issue_*`
 * events are about `sub_issue`, in `repository`, and may name its parent and the parent's repository; `sub_issue_*`
 * events are about `parent_issue`, in `repository`, and may name its child. GitHub leaves the far side out when the App
 * can't see it.
 */
const SubIssues = Schema.Struct({
  action: Schema.Literals(["sub_issue_added", "sub_issue_removed", "parent_issue_added", "parent_issue_removed"]),
  repository: Schema.Struct({ full_name: Schema.String }),
  sub_issue: Schema.optional(Schema.NullOr(Schema.Struct({ number: Schema.Int }))),
  sub_issue_repo: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: Schema.String }))),
  parent_issue: Schema.optional(Schema.NullOr(Schema.Struct({ number: Schema.Int }))),
  parent_issue_repo: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: Schema.String }))),
})
const decodeSubIssues = Schema.decodeUnknownOption(SubIssues)

/** The events whose subject is an issue. */
const ISSUE_EVENTS: ReadonlySet<string> = new Set(["issues", "issue_comment"])

/** A subject a delivery names: a repository and an issue or pull request. */
interface NamedSubject {
  readonly repository: { readonly full_name: string }
  readonly issue: { readonly number: number }
}

/**
 * The issues a delivery of `event` names, the one it is about first. A `sub_issues` delivery can name two: each side whose
 * issue and repository the payload says, never a guess at a far side it leaves out.
 */
const subjectsOf = (event: string, payload: unknown): ReadonlyArray<NamedSubject> => {
  if (ISSUE_EVENTS.has(event)) return Option.toArray(decodeSubject(payload))
  if (PULL_EVENTS.has(event)) {
    return Option.toArray(Option.map(decodePullSubject(payload), (found) => ({
      repository: found.repository,
      issue: { number: found.pull_request.number },
    })))
  }
  if (event !== "sub_issues") return []
  const decoded = decodeSubIssues(payload)
  if (Option.isNone(decoded)) return []
  const { action, repository, sub_issue, sub_issue_repo, parent_issue, parent_issue_repo } = decoded.value
  const parentSide = action.startsWith("sub_issue")
  const near = parentSide ? parent_issue : sub_issue
  const far = parentSide ? sub_issue : parent_issue
  const farRepository = parentSide ? sub_issue_repo : parent_issue_repo
  return [
    ...(near === undefined || near === null ? [] : [{ repository, issue: { number: near.number } }]),
    ...(far === undefined || far === null || farRepository === undefined || farRepository === null
      ? []
      : [{ repository: farRepository, issue: { number: far.number } }]),
  ]
}

/**
 * What the routes need besides Postgres: the deployment's own repository, the GitHub App when it is configured, and
 * who has which role on which repository.
 */
export interface Options<R = never> {
  readonly repository: Repository
  readonly app: Option.Option<GitHubApp>
  readonly roles: RepoRoles.RepoRoles<R>
  /** How the routes' own reads reach GitHub (the compare route's): `fetch` unless set. */
  readonly http?: HttpClient.HttpClient
  /** Whether pushes and pull requests start repositories' flows (`REPO_FLOWS`, docs/features/ci.md#triggers). */
  readonly repoFlows?: boolean
  /** `GITHUB_ALLOWED_REPOSITORIES` (`RepoRoles.allowed`): none, every repository the App is installed on. */
  readonly allowed?: Option.Option<ReadonlySet<string>>
  /**
   * Local development's people, who have no session of their own, with their fixed roles: who among a repository's
   * watchers may read it besides those whose sessions say so (`Notifications.recordRepoEvent`). A deployment passes none.
   */
  readonly localPeople?: ReadonlyArray<Notifications.LocalPerson>
  /**
   * Local development without the App only (worker/DevChatApi.ts): a public repository it syncs beside its own, and the
   * open issue it keeps there, so a draft on that repository's stack has an issue to hang under (decision 0153) and the
   * end-to-end tests commit TODOs on a laptop. Reconcile never runs without the App, so the issues' shapes would
   * otherwise be empty. A deployment never sets it, and with the App it is ignored.
   */
  readonly localSynced?: LocalSynced
}

/** Local development's synced repository and its one open issue (`Options.localSynced`). */
export interface LocalSynced {
  readonly repository: Repository
  readonly issue: GitHub.Issues.Issue
}

/** Ends a person's GitHub connection on smithers.sh when they revoke the App at GitHub (decision 0165). ChatApi supplies it. */
export const EndGitHubConnection = Context.Reference<(githubId: number) => Effect.Effect<void, unknown>>("@smthrs/mvp/EndGitHubConnection", {
  defaultValue: () => () => Effect.void,
})

/** The numeric id of who revoked the App. `ghost` is GitHub's placeholder; decision 0165 relies on a later 401 then. */
export const revokingPerson = (payload: unknown): number | undefined => {
  const sender = (payload as { readonly sender?: { readonly id?: unknown; readonly login?: unknown } }).sender
  const id = sender?.id
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 && sender?.login !== "ghost" ? id : undefined
}

/**
 * Reads Electric's connection and returns the GitHub routes' `fetch`. `database` opens a Postgres client for the scope
 * of each request; `Sessions` (who is asking) and `FlowStarter` (where a remote flow starts) come from the request's
 * context, as RepoApi's do.
 */
export const make = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, options: Options<R>) =>
  Effect.gen(function* () {
    const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })
    const { repository } = options
    const allowed = options.allowed ?? Option.none<ReadonlySet<string>>()
    // Local development's synced repository counts only where there is no App: a deployment with the App decides by
    // its installations and allowed list alone.
    const localSynced = Option.isNone(options.app) ? options.localSynced : undefined
    /**
     * Whether the deployment syncs and acts on repository `id` (decision 0079 §4): its own, or, with the App, any other
     * the allowed list doesn't leave out; without it, local development's synced repository too. Whether the App is
     * installed there is Reconcile's to find out.
     */
    const mayAct = (id: string) =>
      Option.isSome(options.app)
        ? RepoRoles.actsOn(repository, allowed)(id)
        : id === repository.id || id === localSynced?.repository.id
    // Check current metadata for anonymous readers, using the shared metadata token policy.
    const readToken = yield* ReadToken.fromConfig.pipe(
      options.http === undefined ? Effect.provide(FetchHttpClient.layer) : Effect.provideService(HttpClient.HttpClient, options.http),
      Effect.orDie,
    )
    const metadataApiUrl = Option.isSome(options.app) ? options.app.value.apiBaseUrl : (yield* apiUrl)
    const metadataHttp = options.http ?? (yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)))
    const visibility = Visibility.make(metadataApiUrl, readToken, metadataHttp)
    // A pull request's files (worker/github/Compare.ts), read with the App's token: none without the App.
    // Review on request (worker/github/Review.ts): any pull request of a repository the deployment acts on.
    const review = Review.make(database, { repository, app: options.app, roles: options.roles, mayAct })
    const compare = Option.isSome(options.app)
      ? Option.some(yield* Compare.make(options.app.value, Option.fromUndefinedOr(options.http)))
      : Option.none()

    // The webhook's channel (`Core.Channel`): GitHub's HMAC over the exact bytes, then strict JSON into an
    // `ExternalEvent`. Built once, when the secret is configured.
    const channel = Option.flatMap(options.app, (app) =>
      Option.map(app.webhookSecret, (secret) =>
        Core.Channel.make({
          name: "github",
          credential: Redacted.make({ id: "github-webhook", name: "GITHUB_WEBHOOK_SECRET" }),
          secret: Core.Channel.constantSecret(secret),
          verify: (raw, key) =>
            Core.Signature.verifySignature({
              payload: raw.body,
              secret: key,
              signature: raw.headers["x-hub-signature-256"],
              prefix: Core.Signature.GITHUB_SIGNATURE_PREFIX,
            }),
          decode: (raw, payload) => ({
            source: "github",
            eventName: Core.SignalName.eventName("github", raw.headers["x-github-event"] ?? ""),
            correlationId: null,
            payload: payload as Schema.Json,
            dedupeKey: raw.idempotencyKey,
            receivedAtMs: Date.now(),
          }),
          // The routes start `github/Apply` themselves, for the issue a delivery names; a channel needs a route.
          route: Core.Channel.startFlow(Apply._tag),
        })
      ))

    /** `POST /api/github/webhook`. */
    const webhook = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const event = request.headers["x-github-event"] ?? "unknown"
      const metricEvent = new Set(["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment",
        "sub_issues", "push", "release", "ping", "installation", "installation_repositories", "repository", "github_app_authorization"]).has(event) ? event : "unknown"
      const fields: Record<string, string | number> = { event: metricEvent }
      const answer = (status: number, outcome: string, code?: "not_configured" | "invalid_signature" | WriteRefusal) =>
        Effect.gen(function* () {
          fields.outcome = outcome
          yield* Metric.update(Metric.withAttributes(Metrics.webhooks, { event: metricEvent, outcome }), 1)
          return code === undefined
            ? HttpServerResponse.empty({ status, headers: noStore })
            : refuse(status, code)
        })
      const response = yield* Effect.gen(function* () {
        if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        if (Option.isNone(channel)) return yield* answer(503, "not_configured", "not_configured")
        const deliveryId = request.headers["x-github-delivery"] ?? ""
        if (!DELIVERY_ID.test(deliveryId)) return yield* answer(400, "invalid", "invalid")
        fields.deliveryId = deliveryId
        const text = yield* readBounded(request, MAX_WEBHOOK_BYTES, (bytes) => (fields.bytes = bytes)).pipe(Effect.result)
        if (text._tag === "Failure") {
          return text.failure.reason === "too_large"
            ? yield* answer(413, "too_large", "too_large")
            : yield* answer(400, "invalid", "invalid")
        }
        const raw = {
          body: new TextEncoder().encode(text.success),
          headers: { ...request.headers },
          idempotencyKey: deliveryId,
        }
        const verified = yield* channel.value.verify(raw).pipe(Effect.result)
        if (verified._tag === "Failure") return yield* answer(401, "refused", "invalid_signature")
        const decoded = yield* channel.value.decode(raw).pipe(Effect.result)
        if (decoded._tag === "Failure") return yield* answer(400, "invalid", "invalid")
        // `Core.Channel` checked the decoder's output as an `ExternalEvent`.
        const delivered = decoded.success as Core.ExternalEvent.ExternalEvent
        const action = (delivered.payload as { readonly action?: unknown }).action
        // This event names no repository, so it runs before repository resolution. Redelivery is safe: it ends nothing twice.
        if (event === "github_app_authorization" && action === "revoked") {
          const person = revokingPerson(delivered.payload)
          if (person !== undefined) yield* (yield* EndGitHubConnection)(person)
          fields.connection = person === undefined ? "unknown_sender" : "ended"
        }
        // Every issue the delivery names in a repository the deployment acts on (decision 0079, slice 1b).
        let named = subjectsOf(event, delivered.payload).flatMap((found) => {
          const [owner = "", name = ""] = found.repository.full_name.split("/")
          return isRepository(owner, name) && mayAct(repoId(owner, name))
            ? [{ ...found, target: repositoryOf(`${owner}/${name}`) }]
            : []
        })
        if (event === "sub_issues") {
          // A relation cannot introduce an authorization candidate by naming its hidden far side.
          const configured = [repository.id, ...Option.match(allowed, { onNone: () => [], onSome: (ids) => [...ids] })]
          const independent: typeof named = []
          for (const subject of named) {
            const known = yield* TreeScope.candidates(subject.target.owner, configured).pipe(Effect.provide(database))
            if (known.includes(subject.target.id)) independent.push(subject)
          }
          named = independent
        }
        const [firstNamed] = named
        const first = yield* Store.recordDelivery({
          deliveryId,
          event,
          action: typeof action === "string" ? action.slice(0, 64) : null,
          repoId: firstNamed === undefined ? null : firstNamed.target.id,
          subject: firstNamed === undefined ? null : firstNamed.issue.number,
        }).pipe(Effect.provide(database))
        // Only issue and pull request events of a repository the deployment acts on name a subject; the rest (ping,
        // installation, repositories it doesn't act on) are recorded and answered.
        for (const [index, subject] of named.entries()) {
          // A second side of a delivery runs as a parent's refresh does, named by the delivery and the issue.
          const refreshed = index === 0 ? deliveryId : `${deliveryId}:${itemId(subject.target.id, subject.issue.number)}`
          yield* (yield* FlowStarter).start(Apply, {
            executionId: applyExecutionId(refreshed),
            payload: { deliveryId: refreshed, repo: `${subject.target.owner}/${subject.target.name}`, number: subject.issue.number, event },
          })
        }
        if (firstNamed !== undefined) {
          const number = firstNamed.issue.number
          const target = firstNamed.target
          fields.number = number
          fields.repoId = target.id
          const repo = `${target.owner}/${target.name}`
          // A new issue, while triage is on: the repository's triage flow decides it (decision 0012 §5).
          if (event === "issues" && action === "opened" && (yield* TriageStore.isOn(target.id).pipe(Effect.provide(database)))) {
            fields.triage = "started"
            yield* (yield* FlowStarter).start(TriageRun, {
              executionId: triageRunExecutionId(deliveryId),
              payload: { repo, number, trigger: "opened", key: deliveryId },
            })
          }
        }
        const mirror = MirrorRefresh.pushRepository(event, delivered.payload)
        if (Option.isSome(mirror)) {
          yield* MirrorRefresh.request(mirror.value.owner, mirror.value.name, deliveryId)
          fields.mirror = "requested"
        }
        // A push or a pull request of any repository the App is installed on: its flows' triggers decide what runs
        // (docs/features/ci.md#triggers), on the delivery's own `triggers/Dispatch`.
        const dispatch = options.repoFlows === true ? Dispatch.requestOf(event, deliveryId, delivered.payload) : Option.none()
        if (Option.isSome(dispatch)) {
          yield* (yield* FlowStarter).start(Dispatch.Dispatch, {
            executionId: Dispatch.dispatchExecutionId(deliveryId),
            payload: dispatch.value,
          })
          fields.dispatched = dispatch.value.repo
        }
        // `main` moving and a new release reach everyone watching the repository (decision 0009 §8).
        const now = new Date(yield* Clock.currentTimeMillis)
        const repoEvent = Notifications.repoEventOf(event, delivered.payload, repository, now)
        if (Option.isSome(repoEvent)) {
          fields.notified = yield* Notifications.recordRepoEvent(repoEvent.value, options.localPeople).pipe(
            Effect.provide(database),
          )
        }
        if (!first) return yield* answer(200, "duplicate")
        return yield* answer(200, firstNamed !== undefined || Option.isSome(repoEvent) || Option.isSome(dispatch) || Option.isSome(mirror) ? "applied" : "ignored")
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            fields.errorCode = codeOf(Cause.squash(cause))
            return yield* answer(503, "unavailable", "unavailable")
          })
        ),
      )
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
      yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
        "github.webhook",
      ).pipe(Effect.annotateLogs({ ...fields, status: response.status }))
      return response
    }).pipe(Effect.withSpan("github.webhook", { kind: "server" }))

    /** Starts the owner's dispatcher. Its id is the epoch's, so a start that was lost is made good by any later request. */
    const startDispatch = (owner: string) =>
      Effect.gen(function* () {
        const epoch = yield* MachineWrite.launch(owner).pipe(Effect.provide(database))
        yield* (yield* FlowStarter).start(MachineWrite.MachineDispatch, {
          executionId: MachineWrite.dispatchExecutionId(owner, epoch),
          payload: MachineWrite.dispatchPayload(owner, epoch),
        })
      })

    /**
     * `POST /api/repos/<owner>/<name>/writes` with a machine token (docs/features/machine-tokens.md). It reads no
     * session and reaches no person's path: the token's own repository and scope decide, and the App writes.
     */
    const machineWrites = (target: { readonly owner: string; readonly name: string }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
        if (!isRepository(target.owner, target.name)) return refuse(404, "not_found")
        const repo = repositoryOf(`${target.owner}/${target.name}`)
        if (!mayAct(repo.id)) return refuse(404, "not_found")
        if (Option.isNone(options.app)) return refuse(503, "not_configured")
        const machine = yield* MachineWrite.machineOf(request, repo.id).pipe(Effect.provide(database))
        if (Option.isNone(machine)) return refuse(401, "authentication")
        const text = yield* readBounded(request, MAX_WRITE_BYTES).pipe(Effect.result)
        if (text._tag === "Failure") return text.failure.reason === "too_large" ? refuse(413, "too_large") : refuse(400, "invalid")
        const body = MachineWrite.decodeBody(text.success)
        if (Option.isNone(body)) return refuse(400, "invalid")
        const write = body.value
        if (!machine.value.scope.includes(write.op)) return refuse(403, "forbidden")
        // The body is filed escaped, with the server's attribution and marker: it must still fit GitHub's limit.
        if ("body" in write && typeof write.body === "string" && !MachineWrite.fitsGitHub(write.body, machine.value.agent, machine.value.lane)) return refuse(413, "too_large")
        // What a machine posts is public, and a `smithers:` label is a person's or a flow's: refused whatever sent it.
        const content = MachineWrite.refusalOf(write)
        if (content !== undefined) {
          yield* Effect.logWarning("github.machine_write.request").pipe(Effect.annotateLogs({ op: write.op, agent: machine.value.agent, lane: machine.value.lane, outcome: content }))
          return content === "reserved_label" ? refuse(403, "forbidden") : HttpServerResponse.jsonUnsafe({ code: "public_content", reason: content }, { status: 422, headers: noStore })
        }
        // A sub-issue writes to its parent's repository too: it must be one this deployment acts on.
        const parent = write.op === "issue/relate" ? repositoryOf(write.parent.repo) : undefined
        if (parent !== undefined && !mayAct(parent.id)) return refuse(404, "not_found")
        const owner = repo.owner.toLowerCase()
        const admitted = yield* MachineWrite.admit({ repoId: repo.id, owner, machine: machine.value, body: write }).pipe(Effect.provide(database))
        if (admitted.kind === "token") return refuse(401, "authentication")
        if (admitted.kind === "parent") return refuse(403, "forbidden")
        if (admitted.kind === "conflict") return refuse(409, "conflict")
        if (admitted.kind === "backlog") return refuse(429, "rate_limited", 30)
        if (admitted.kind === "inserted" || admitted.status === "pending") yield* startDispatch(owner)
        yield* Effect.logInfo("github.machine_write.request").pipe(
          Effect.annotateLogs({ op: write.op, writeId: write.writeId, agent: machine.value.agent, lane: machine.value.lane, outcome: admitted.kind }),
        )
        return HttpServerResponse.jsonUnsafe(
          { writeId: write.writeId, ...(admitted.kind === "existing" ? { status: admitted.status } : {}) },
          { status: admitted.kind === "inserted" ? 202 : 200, headers: noStore },
        )
      }).pipe(Effect.catchCause(() => Effect.succeed(refuse(503, "unavailable"))))

    /** `GET .../writes/<id>`: its status and issue number. `POST .../writes/<id>/retry`: a failed write, back in the queue. */
    const machineWriteStatus = (target: { readonly owner: string; readonly name: string; readonly id: string; readonly retry: boolean }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const method = target.retry ? "POST" : "GET"
        if (request.method !== method) return HttpServerResponse.empty({ status: 405, headers: { allow: method } })
        if (!isRepository(target.owner, target.name)) return refuse(404, "not_found")
        const repo = repositoryOf(`${target.owner}/${target.name}`)
        const machine = yield* MachineWrite.machineOf(request, repo.id).pipe(Effect.provide(database))
        if (Option.isNone(machine)) return refuse(401, "authentication")
        if (target.retry) {
          if (!mayAct(repo.id)) return refuse(404, "not_found")
          const again = yield* MachineWrite.retry(target.id, repo.id, machine.value, mayAct).pipe(Effect.provide(database))
          if (again === "conflict") return refuse(409, "conflict")
          if (again === "forbidden") return refuse(403, "forbidden")
          if (again === "backlog") return refuse(429, "rate_limited", 30)
          yield* startDispatch(repo.owner.toLowerCase())
          return HttpServerResponse.jsonUnsafe({ writeId: target.id, status: "pending" }, { status: 202, headers: noStore })
        }
        const found = yield* MachineWrite.statusOf(target.id, repo.id, machine.value).pipe(Effect.provide(database))
        return Option.isNone(found)
          ? refuse(404, "not_found")
          : HttpServerResponse.jsonUnsafe(found.value, { status: 200, headers: noStore })
      }).pipe(Effect.catchCause(() => Effect.succeed(refuse(503, "unavailable"))))

    /** `POST /api/repos/<owner>/<name>/writes`. */
    const writes = (target: { readonly owner: string; readonly name: string }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Record<string, string | number> = {}
        const refused = (status: number, code: WriteRefusal) => {
          fields.outcome = code
          return refuse(status, code)
        }
        const response = yield* Effect.gen(function* () {
          if (request.method !== "POST") {
            fields.outcome = "method"
            return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
          }
          const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
          if (Option.isNone(actor)) return refused(503, "unavailable")
          if (Option.isNone(actor.value)) return refused(401, "authentication")
          const signed = actor.value.value
          if (!isRepository(target.owner, target.name)) return refused(404, "not_found")
          const repo = repositoryOf(`${target.owner}/${target.name}`)
          const own = repo.id === repository.id
          fields.repoId = repo.id
          fields.repository = own ? "own" : "other"
          // Every write needs a role on the repository. No role means a repository the person can't see. On the
          // deployment's own repository that is the session's role, checked before the App as it always was.
          if (own && signed.role === null) return refused(403, "forbidden")
          if (Option.isNone(options.app)) return refused(503, "not_configured")
          const resolved = yield* options.roles.resolve(signed, repo).pipe(Effect.result)
          if (resolved._tag === "Failure") {
            const { code, retryAfterSeconds } = resolved.failure
            fields.outcome = code
            return refuse(RepoRoles.REFUSALS[code], code, retryAfterSeconds)
          }
          const who: Actor = { ...signed, role: resolved.success.role }
          if (who.role === null) return refused(403, "forbidden")
          const text = yield* readBounded(request, MAX_WRITE_BYTES).pipe(Effect.result)
          if (text._tag === "Failure") {
            return text.failure.reason === "too_large" ? refused(413, "too_large") : refused(400, "invalid")
          }
          const body = decodeWrite(text.success)
          if (Option.isNone(body)) return refused(400, "invalid")
          const write = body.value
          const via = viaOf(who)
          fields.op = write.op
          fields.via = via
          fields.writeId = write.writeId
          // Triage is the person's own act: anyone acting for them is refused, and counted as such (decision 0017).
          if (
            write.op !== "issue/create" && write.op !== "issue/comment" && write.op !== "branch/publish" &&
            write.op !== "branch/update" && write.op !== "branch/resync" && (yield* refusesPersonOnly(who, write.op))
          ) {
            return refused(403, "forbidden")
          }
          // A person's own write to GitHub runs with their GitHub token, which only a signed-in session holds.
          if (withPersonToken(write, via) && who.session === undefined) return refused(401, "authentication")
          // The agent's write runs as the App. Only a person who may ask Smithers has an agent (decision 0007
          // `repo:ask`, Member or above), so a Guest's write goes as the Guest or not at all, never as the bot.
          if (via === "agent" && !canAsk(who)) return refused(403, "forbidden")
          if (!mayWrite(who, write)) return refused(403, "forbidden")
          // Triage judges on the model of the person who enabled it: their own, else the deployment's, which answers only
          // Members of the deployment's own repository (ruling AUTH-8, decision 0122). Enabling it, on any repository,
          // needs one of the two; Run triage again judges on the enabler's, as a new issue's run does.
          if (
            write.op === "triage/enable" && !canAsk(signed) &&
            !(yield* PersonalStore.hasModel(who.subject.id).pipe(Effect.provide(database)))
          ) {
            fields.refused = "deployment_model"
            return refused(403, "forbidden")
          }
          // The App writes triage under the role of the person who enabled it, re-checked by their GitHub login.
          if (write.op === "triage/enable" && who.login === undefined) return refused(401, "authentication")
          // Publish, Update branch and Resync: a branch of this repository the writer may edit; Publish and Resync, one
          // at a time per branch.
          if (write.op === "branch/publish" || write.op === "branch/update" || write.op === "branch/resync") {
            if (!canAsk(signed)) return refused(403, "forbidden")
            const branchId = write.branchId.toLowerCase()
            fields.branchId = branchId
            // A branch of another repository is not found here before anyone's role there is asked: its repository's
            // GitHub metadata never decides this route's answer.
            const located = yield* branchAccessAs(Option.none(), branchId).pipe(Effect.provide(database))
            if (located === undefined || located.repoId !== repo.id) return refused(404, "not_found")
            const branch = yield* branchAccess(Option.some(who), branchId).pipe(Effect.provide(database))
            if (branch === undefined || branch.repoId !== repo.id) return refused(404, "not_found")
            if (!canEdit(branch.access)) return refused(403, "forbidden")
            if (write.op === "branch/publish" || write.op === "branch/resync") {
              const blocked = yield* publishBlocked(branchId, write.writeId).pipe(Effect.provide(database))
              if (blocked !== undefined) {
                fields.blocked = blocked
                return refused(409, "conflict")
              }
            }
          }
          const plain = payloadOf(write)
          const payloadHash = digestSync(JSON.stringify({ via, ...plain }))
          const insert = (held: Option.Option<RepoRoles.Held>) =>
            Store.insertWrite({
              id: write.writeId,
              repoId: repo.id,
              actorId: who.subject.id,
              sessionId: via === "person" ? who.session ?? null : null,
              via,
              payload: plain.op === "triage/enable" || plain.op === "triage/pause"
                ? { ...plain, authority: WriteAuthority.protectedOf(who, held) } : plain,
              payloadHash,
              reauthorize: plain.op === "triage/enable" || plain.op === "triage/pause",
            }, Option.isSome(held) ? RepoRoles.holds(held.value) : undefined).pipe(Effect.provide(database))
          let inserted = yield* insert(resolved.success.held)
          // The row the request read expired, or changed, before the write's transaction: GitHub decides again, once,
          // and the write is admitted only under that answer (decision 0079 §6). The five minutes still hold.
          const read = resolved.success.held
          if (inserted.kind === "stale" && Option.isSome(read) && options.roles.refresh !== undefined) {
            fields.refreshed = 1
            const again = yield* options.roles.refresh(signed, repo, read.value).pipe(Effect.result)
            if (again._tag === "Failure") {
              const { code, retryAfterSeconds } = again.failure
              fields.outcome = code
              return refuse(RepoRoles.REFUSALS[code], code, retryAfterSeconds)
            }
            const now: Actor = { ...signed, role: again.success.role }
            if (now.role === null || !mayWrite(now, write) || (via === "agent" && !canAsk(now))) return refused(403, "forbidden")
            inserted = yield* insert(again.success.held)
            // The row the refresh answered expired or changed again before this insert: the role GitHub just gave
            // allows the write, so the outbox sends it again (`503`), never the terminal 403.
            if (inserted.kind === "stale") {
              fields.outcome = "unavailable"
              return refuse(503, "unavailable", 1)
            }
          }
          // The role changed between the read and the write: decided again on the next send.
          if (inserted.kind === "stale") return refused(403, "forbidden")
          // Another repository's or another person's write id is never theirs to resend.
          if (inserted.kind === "taken") return refused(409, "conflict")
          if (inserted.kind === "existing" && inserted.payloadHash !== payloadHash) return refused(409, "conflict")
          // A new write starts its run; a resend starts the same execution again, which changes nothing, so a start
          // that never reached its Durable Object gets there now. Run triage again is its own run: `triage/Run`
          // settles the write.
          if (inserted.kind === "inserted" || inserted.status === "pending") {
            yield* write.op === "triage/run"
              ? (yield* FlowStarter).start(TriageRun, {
                executionId: triageRunExecutionId(write.writeId),
                payload: {
                  repo: `${repo.owner}/${repo.name}`,
                  number: write.number,
                  trigger: "again",
                  key: write.writeId,
                },
              })
              : write.op === "pr/merge"
              ? (yield* FlowStarter).start(Merge, {
                executionId: mergeExecutionId(write.writeId),
                payload: { writeId: write.writeId },
              })
              : write.op === "branch/publish"
              ? (yield* FlowStarter).start(Publish, {
                executionId: publishExecutionId(write.writeId),
                payload: { writeId: write.writeId },
              })
              : write.op === "branch/update"
              ? (yield* FlowStarter).start(Update, {
                executionId: updateExecutionId(write.writeId),
                payload: { writeId: write.writeId },
              })
              : write.op === "branch/resync"
              ? (yield* FlowStarter).start(Resync, {
                executionId: resyncExecutionId(write.writeId),
                payload: { writeId: write.writeId },
              })
              : (yield* FlowStarter).start(Write, {
                executionId: writeExecutionId(write.writeId),
                payload: { writeId: write.writeId },
              })
          }
          if (inserted.kind === "existing") {
            fields.outcome = inserted.reauthorized === true ? "reauthorized" : "existing"
            return HttpServerResponse.jsonUnsafe(
              { txid: null, writeId: write.writeId, status: inserted.status },
              { status: 200, headers: noStore },
            )
          }
          fields.outcome = "started"
          return HttpServerResponse.jsonUnsafe(
            { txid: inserted.txid, writeId: write.writeId },
            { status: 202, headers: noStore },
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              fields.errorCode = codeOf(Cause.squash(cause))
              return refused(503, "unavailable")
            })
          ),
        )
        const outcome = String(fields.outcome)
        yield* Metric.update(
          Metric.withAttributes(Metrics.writeRequests, {
            op: String(fields.op ?? "unknown"),
            outcome,
            repository: String(fields.repository ?? "unknown"),
          }),
          1,
        )
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
          "github.write.request",
        ).pipe(
          Effect.annotateLogs({
            ...fields,
            outcome,
            status: response.status,
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          }),
        )
        return response
      }).pipe(Effect.withSpan("github.write.request", { kind: "server" }))

    // The last admitted bucket per repository: completed values only. Each request that finds a bucket behind
    // starts it itself, without sharing pending work (decision 0104).
    const admitted = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
    const refreshPull = yield* PullRefresh.make(database, Option.isSome(options.app), RECONCILE_START_TIMEOUT)

    /**
     * Starts `github/Reconcile` when `target`'s issues are older than `SYNC_STALE_MS`, one execution per repository and
     * 5-minute bucket, and waits at most `RECONCILE_START_TIMEOUT` for admission. A bucket admitted for that repository
     * isn't asked again. It never fails the read: each start logs `github.reconcile.start` and counts
     * `github_reconcile_starts` by outcome (`started`, `timed_out`, `not_started` with its error code).
     */
    const reconcileIfStale = (target: Repository) => Effect.gen(function* () {
      if (Option.isNone(options.app)) {
        // Local development's synced repository keeps its one issue, read as of its own `updated_at`: an upsert that
        // changes nothing once the row is there, and puts it back if the dev database was reset.
        if (localSynced !== undefined && target.id === localSynced.repository.id) {
          yield* Store.upsertIssue(target.id, localSynced.issue, Date.parse(localSynced.issue.updated_at)).pipe(
            Effect.provide(database),
            Effect.catchCause(() => Effect.logWarning("github.local_synced.seed").pipe(Effect.annotateLogs({ repoId: target.id, outcome: "failed" }))),
          )
        }
        return
      }
      const now = yield* Clock.currentTimeMillis
      const state = yield* Store.syncState(target.id, ISSUES_STREAM).pipe(Effect.provide(database))
      if (state.syncedAt !== null) yield* Metric.update(Metrics.syncAge, Math.round((now - state.syncedAt) / 1000))
      if (state.syncedAt !== null && now - state.syncedAt < SYNC_STALE_MS) return
      const bucket = reconcileBucketStart(now)
      if ((yield* Ref.get(admitted)).get(target.id) === bucket) return
      const started = yield* (yield* FlowStarter).start(Reconcile, {
        executionId: reconcileExecutionId(target.id, now),
        payload: { repo: `${target.owner}/${target.name}`, requestedAtMs: bucket },
      }).pipe(Effect.timeoutOption(RECONCILE_START_TIMEOUT))
      const outcome = Option.isSome(started) ? "started" : "timed_out"
      if (Option.isSome(started)) yield* Ref.update(admitted, (buckets) => new Map(buckets).set(target.id, bucket))
      yield* Metric.update(Metric.withAttributes(Metrics.reconcileStarts, { outcome }), 1)
      yield* Effect.logWithLevel(outcome === "started" ? "Info" : "Warn")("github.reconcile.start").pipe(
        Effect.annotateLogs({
          repoId: target.id,
          outcome,
          durationMs: (yield* Clock.currentTimeMillis) - now,
          ...(Option.isNone(started) ? { errorCode: "TimeoutError" } : {}),
        }),
      )
    }).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        return Effect.andThen(
          Metric.update(Metric.withAttributes(Metrics.reconcileStarts, { outcome: "not_started" }), 1),
          Effect.logWarning("github.reconcile.start").pipe(
            Effect.annotateLogs({
              repoId: target.id,
              outcome: "not_started",
              errorCode: error instanceof StartUnavailable ? error.errorCode : codeOf(error),
            }),
          ),
        )
      }),
      Effect.withSpan("github.reconcile.start"),
    )

    /**
     * The repository a shape names, `?repo=<owner>/<name>`, the deployment's own unless it names one; `400 invalid` for
     * a name GitHub couldn't have. Whether the deployment acts on it is `repositoryReadable`'s to say.
     */
    const shapeTarget = (url: string): Result.Result<Repository, HttpServerResponse.HttpServerResponse> => {
      const named = new URL(url, "http://localhost").searchParams.get("repo")
      if (named === null) return Result.succeed(repository)
      const [owner = "", name = "", ...rest] = named.split("/")
      if (rest.length !== 0 || !isRepository(owner, name)) return Result.fail(refuse(400, "invalid"))
      // Whether the deployment acts on it is `repositoryReadable`'s first check.
      return Result.succeed(repositoryOf(`${owner}/${name}`))
    }

    /** An Electric shape of `table` with its `columns`, filtered by `where` and `params`. */
    const shape = (
      table: string,
      columns: ReadonlyArray<string>,
      where: string,
      params: Readonly<Record<string, string>>,
    ) =>
      ShapeProxy.make({
        ...connection,
        shape: { table, where, params, columns },
        name: `github.shape.${table}`,
        metric: Metric.withAttributes(Metrics.shapes, { table }),
      })

    /**
     * Who may read a repository's content (worker/github/Access.ts): the one predicate the shapes, the issue list and
     * every other repository read share.
     */
    const access = Access.make({ repository, mayAct, roles: options.roles, visibility, database })
    /** A refused proof as the readers answer it: the refusal's status and code, and how long to wait when known. */
    const refusalOf = (proof: Access.Proof & { readonly _tag: "Refused" }) => refuse(proof.status, proof.refusal, proof.retryAfterSeconds)

    /**
     * What the reader may read among `target`'s owner's repositories, `target` first asked and always among them: the
     * ids, sorted, or the refusal to answer. Nothing here depends on a relation row, so hidden relations change no read
     * and no call. A repository whose role can't be read now refuses the whole answer rather than shrink the tree.
     */
    const readableSet = (target: Repository) =>
      Effect.gen(function* () {
        const listed = Option.match(allowed, { onNone: () => [] as ReadonlyArray<string>, onSome: (ids) => [...ids] })
        const known = yield* TreeScope.candidates(target.owner, listed).pipe(
          Effect.provide(database), Effect.result,
          Effect.tap((read) => Effect.annotateCurrentSpan({ "smithers.github.outcome": read._tag === "Failure" ? "unavailable" : "read" })),
          Effect.withSpan("github.tree_candidates"),
        )
        const outcome = known._tag === "Failure" ? "unavailable" : "read"
        yield* Metric.update(Metric.withAttributes(Metrics.treeCandidateReads, { outcome }), 1)
        if (known._tag === "Failure") {
          yield* Effect.logWarning("github.tree_candidates").pipe(
            Effect.annotateLogs({ repoId: target.id, outcome, errorCode: codeOf(known.failure) }),
          )
          return { _tag: "Refused", proof: {
            _tag: "Refused", target, stage: "viewer", refusal: "unavailable", status: 503,
          } } as const
        }
        const others = known.success.filter((id) => id !== target.id && mayAct(id)).map((id) => repositoryOf(TreeScope.nameOf(id)))
        const [own, ...rest] = yield* access.readableAmong([target, ...others])
        if (own!._tag === "Refused") return { _tag: "Refused", proof: own! } as const
        const down = rest.find((proof) => proof._tag === "Refused" && proof.refusal === "unavailable")
        if (down !== undefined && down._tag === "Refused") return { _tag: "Refused", proof: down } as const
        const ids = [own!, ...rest].filter((proof) => proof._tag === "Readable").map((proof) => proof.target.id)
        return { _tag: "Readable", ids: [...new Set(ids)].sort() } as const
      })

    const relationsAdmitted = yield* Ref.make<ReadonlyMap<string, number>>(new Map())

    /** Starts `github/Relations` for `target`, once per repository and 5-minute bucket; it never fails the read. */
    const startRelations = (target: Repository) => Effect.gen(function* () {
      if (Option.isNone(options.app)) return
      const now = yield* Clock.currentTimeMillis
      const bucket = reconcileBucketStart(now)
      if ((yield* Ref.get(relationsAdmitted)).get(target.id) === bucket) return
      const started = yield* (yield* FlowStarter).start(Relations, {
        executionId: relationsExecutionId(target.id, now),
        payload: { repo: `${target.owner}/${target.name}`, requestedAtMs: bucket },
      }).pipe(Effect.timeoutOption(RECONCILE_START_TIMEOUT))
      if (Option.isSome(started)) yield* Ref.update(relationsAdmitted, (buckets) => new Map(buckets).set(target.id, bucket))
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("github.relations.start").pipe(
          Effect.annotateLogs({ repoId: target.id, errorCode: codeOf(Cause.squash(cause)) }),
        )
      ),
    )

    /**
     * `GET /api/repos/<owner>/<name>/issues/tree-scope` (worker/github/TreeScope.ts): the repositories the tree reaches,
     * for this reader alone, `private, no-store`. One span and log line and one count by outcome; never an issue, a name
     * or who asks. A repository in scope whose relations aren't current starts its walk here.
     */
    const treeScope = (named: { readonly owner: string; readonly name: string }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const fields: Record<string, string | number> = {}
        const response = yield* Effect.gen(function* () {
          if (request.method !== "GET") {
            fields.outcome = "method"
            return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
          }
          const target = repositoryOf(`${named.owner}/${named.name}`)
          fields.repoId = target.id
          const readable = yield* readableSet(target)
          if (readable._tag === "Refused") {
            fields.outcome = readable.proof.stage === "viewer" ? "refused" : readable.proof.refusal
            return refusalOf(readable.proof as Access.Proof & { readonly _tag: "Refused" })
          }
          const now = yield* Clock.currentTimeMillis
          const found = yield* Effect.gen(function* () {
            const pairs = yield* TreeScope.reachedPairs(target.id, readable.ids)
            const ordered = TreeScope.byDistance(target.id, pairs)
            const synced = yield* TreeScope.currentRelations(ordered, now)
            return { ordered, synced }
          }).pipe(Effect.provide(database), Effect.result)
          if (found._tag === "Failure") {
            fields.outcome = "unavailable"
            fields.errorCode = codeOf(found.failure)
            return refuse(503, "unavailable")
          }
          const scope = TreeScope.answer(found.success.ordered, found.success.synced)
          yield* Effect.forEach(
            found.success.ordered.slice(0, scope.repos.length).filter((id) => !found.success.synced.has(id)),
            (id) => startRelations(repositoryOf(TreeScope.nameOf(id))),
            { concurrency: 4, discard: true },
          )
          fields.outcome = "answered"
          fields.repos = scope.repos.length
          fields.omitted = scope.omitted.length
          return HttpServerResponse.jsonUnsafe(scope, { headers: { "cache-control": "private, no-store" } })
        })
        yield* Metric.update(Metric.withAttributes(Metrics.treeScopes, { outcome: String(fields.outcome) }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
        yield* Effect.logWithLevel(response.status >= 500 ? "Warn" : "Info")("github.tree_scope").pipe(
          Effect.annotateLogs({ ...fields, status: response.status }),
        )
        return response
      }).pipe(Effect.withSpan("github.tree_scope", { kind: "server" }))

    /**
     * `GET /api/shapes/github-writes`: the signed-in person's own writes; signed out, none; sessions unreadable, 503
     * (worker/ShapeAccess.ts), never another person's scope under the device's handle.
     */
    const ownWrites = ShapeProxy.make({
      ...connection,
      shape: Effect.map(ShapeAccess.actor, (actor) => ({
        table: WRITES_TABLE,
        where: "actor_id = $1",
        params: { "1": Option.match(actor, { onNone: () => NOBODY, onSome: (actor) => actor.subject.id }) },
        columns: WRITE_COLUMNS,
      })),
      name: `github.shape.${WRITES_TABLE}`,
      metric: Metric.withAttributes(Metrics.shapes, { table: WRITES_TABLE }),
    })

    /**
     * `GET /api/repos/<owner>/<name>/issues` (worker/github/IssueList.ts): one page of the repository's issues, read
     * as its shapes are, and a stale read starts its Reconcile as theirs do. One span and log line
     * `github.issues.list` and one count by outcome; never a title or a query.
     */
    const issues = (named: { readonly owner: string; readonly name: string }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Record<string, string | number> = {}
        const response = yield* Effect.gen(function* () {
          if (request.method !== "GET") {
            fields.outcome = "method"
            return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
          }
          const target = repositoryOf(`${named.owner}/${named.name}`)
          fields.repoId = target.id
          const search = new URL(request.url, "http://localhost").searchParams
          const query = IssueList.parseQuery(search)
          // A runner registered on the repository reads its issues with its own token, as it reads its jobs.
          const { proof } = yield* access.repositoryReadable(target, "session_or_runner", { validate: Effect.succeed(query !== undefined) })
          if (proof._tag === "Refused") {
            fields.outcome = proof.stage === "viewer" ? "refused" : proof.refusal
            return refusalOf(proof)
          }
          if (proof.via === "runner") fields.by = "runner"
          const [, found] = yield* Effect.all([
            reconcileIfStale(target),
            IssueList.page(target.id, query!).pipe(Effect.provide(database), Effect.result),
          ], { concurrency: 2 })
          if (found._tag === "Failure") {
            fields.outcome = "unavailable"
            fields.errorCode = codeOf(found.failure)
            return refuse(503, "unavailable")
          }
          fields.outcome = "listed"
          fields.count = found.success.issues.length
          fields.more = found.success.next === undefined ? 0 : 1
          return IssueList.answer(named, search, found.success)
        })
        const outcome = String(fields.outcome)
        yield* Metric.update(Metric.withAttributes(Metrics.issueLists, { outcome }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, "smithers.issues.outcome": outcome })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : "Info")("github.issues.list").pipe(
          Effect.annotateLogs({ ...fields, status: response.status, durationMs: (yield* Clock.currentTimeMillis) - startedAt }),
        )
        return response
      }).pipe(Effect.withSpan("github.issues.list", { kind: "server" }))

    /**
     * `GET /api/repos/<owner>/<name>/first-paint` (worker/github/FirstPaint.ts, devpriv FINAL §3.10): an issue's heading
     * or the list's first page for the session cookie's person alone, read under the shapes' rule, within
     * `FIRST_PAINT_DEADLINE_MS`. Anything but a paint is an empty `204`. One span and log line `github.first_paint` and
     * one count by form and outcome; never a title, a number or a person.
     */
    const firstPaint = (named: { readonly owner: string; readonly name: string }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const form = FirstPaint.parseForm(new URL(request.url, "http://localhost").searchParams)
        const target = repositoryOf(`${named.owner}/${named.name}`)
        const fields: Record<string, string | number> = { form: form?.kind ?? "invalid", repoId: target.id }
        const response = yield* FirstPaint.guarded((fields) => Effect.gen(function* () {
          // Any other method is one more outcome that doesn't paint: the same empty 204.
          if (request.method !== "GET") {
            fields.outcome = "method"
            return FirstPaint.nothing()
          }
          const { proof } = yield* access.repositoryReadable(target, "cookie", { validate: Effect.succeed(form !== undefined) })
          if (proof._tag === "Refused") {
            fields.outcome = `refused_${proof.status}`
            return FirstPaint.nothing()
          }
          const found = yield* FirstPaint.read(target.id, form!).pipe(Effect.provide(database))
          if (found === undefined) {
            fields.outcome = "missing"
            return FirstPaint.nothing()
          }
          fields.outcome = "painted"
          const person = proof.viewer.kind === "person" ? proof.viewer.actor : undefined
          // A person's deadline counts in the database's clock, from the lookup that read the session's end; a public
          // read signed out has no session, and only the shell's hand-over cap bounds it.
          return FirstPaint.painted({
            viewer: person?.subject.id ?? null,
            ...(person?.expiry === undefined
              ? { serverNow: yield* Clock.currentTimeMillis }
              : { expiresAt: person.expiry.at, serverNow: person.expiry.now }),
            ...found,
          })
        }), fields, codeOf)
        const outcome = String(fields.outcome)
        yield* Metric.update(Metric.withAttributes(Metrics.firstPaints, { form: String(fields.form), outcome }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, "smithers.first_paint.outcome": outcome })
        yield* Effect.logWithLevel(outcome === "error" ? "Warn" : "Info")("github.first_paint").pipe(
          Effect.annotateLogs({ ...fields, status: response.status, durationMs: (yield* Clock.currentTimeMillis) - startedAt }),
        )
        return response
      }).pipe(Effect.withSpan("github.first_paint", { kind: "server" }))

    /**
     * `POST /api/repos/<owner>/<name>/issues/<number>/links` (decision 0147, docs/features/work-links.md): a Member or
     * above, in their session or a run's credential, or a runner registered on the repository, with its token, posts
     * what links the issue to the work on it. One span and log line `work.links` and one count by outcome and who
     * posted (`person` or `runner`); never a ref, a label or a URL.
     */
    const links = (named: { readonly owner: string; readonly name: string; readonly number: number }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const startedAt = yield* Clock.currentTimeMillis
        const fields: Record<string, string | number> = { number: named.number }
        const refused = (status: number, code: string, outcome = code) => {
          fields.outcome = outcome
          return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
        }
        const response = yield* Effect.gen(function* () {
          if (request.method !== "POST") {
            fields.outcome = "method"
            return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
          }
          const target = repositoryOf(`${named.owner}/${named.name}`)
          fields.repoId = target.id
          if (!mayAct(target.id)) return refused(404, "not_found")
          const actor = yield* (yield* Sessions).resolve.pipe(Effect.option)
          if (Option.isNone(actor)) return refused(503, "unavailable")
          let source: string
          let byRunner: { readonly tokenSha256: string } | undefined
          let byMachine: { readonly tokenSha256: string } | undefined
          // The body is read before a runner is authorized: the write then checks the runner again, in its own
          // transaction, so a token revoked while the body arrived writes nothing (decision 0148).
          const text = yield* readBounded(request, WorkLinks.MAX_POST_BYTES).pipe(Effect.result)
          if (Option.isSome(actor.value)) {
            fields.by = "person"
            const resolved = yield* WriteAuthority.wait("role", options.roles.resolve(actor.value.value, target)).pipe(Effect.result)
            if (resolved._tag === "Failure") {
              const { code, retryAfterSeconds } = resolved.failure
              fields.outcome = code
              return refuse(RepoRoles.REFUSALS[code], code, retryAfterSeconds)
            }
            if (!mayAsk(resolved.success.role)) return refused(403, "forbidden")
            source = actor.value.value.login ?? actor.value.value.subject.id
          } else {
            const machine = yield* MachineWrite.machineOf(request, target.id).pipe(Effect.provide(database), Effect.result)
            if (machine._tag === "Failure") return refused(503, "unavailable")
            if (Option.isSome(machine.success)) {
              fields.by = "machine"
              if (!machine.success.value.scope.includes("work/link")) return refused(403, "forbidden")
              source = `machine:${machine.success.value.agent}/${machine.success.value.lane}`
              byMachine = { tokenSha256: machine.success.value.tokenSha256 }
            } else {
            fields.by = "runner"
            const runner = yield* WriteAuthority.wait("runner_lookup", WorkLinks.runnerOf(request, target.id).pipe(Effect.provide(database))).pipe(Effect.result)
            if (runner._tag === "Failure") return refused(503, "unavailable")
            if (Option.isNone(runner.success)) return refused(401, "authentication")
            // Registered, but not current as a claim requires (decision 0148): it needs registering again.
            if (runner.success.value._tag !== "Runner") return refused(403, "not_authorized")
            source = `runner:${runner.success.value.name}`
            byRunner = { tokenSha256: runner.success.value.tokenSha256 }
            }
          }
          if (text._tag === "Failure") {
            return text.failure.reason === "too_large" ? refused(413, "too_large") : refused(400, "invalid")
          }
          const post = WorkLinks.decode(text.success)
          const now = yield* Clock.currentTimeMillis
          if (post === undefined || WorkLinks.fromTheFuture(post, now)) return refused(400, "invalid")
          if (byMachine !== undefined && MachineWrite.publicContentProblem(post.links.flatMap((link) => [link.ref, link.label, link.url])) !== undefined) {
            return refused(400, "invalid")
          }
          const written = yield* WriteAuthority.wait("commit", WorkLinks.write(target.id, named.number, post, source, now, byRunner, byMachine).pipe(
            Effect.provide(database),
          )).pipe(Effect.result)
          if (written._tag === "Failure") {
            fields.errorCode = codeOf(written.failure)
            return refused(503, "unavailable")
          }
          if (Option.isNone(written.success)) return refused(403, "not_authorized")
          fields.outcome = "written"
          fields.links = written.success.value.links
          fields.changed = written.success.value.changed
          return HttpServerResponse.jsonUnsafe(written.success.value, { headers: noStore })
        })
        const outcome = String(fields.outcome)
        yield* Metric.update(Metric.withAttributes(Metrics.workLinkPosts, { outcome, by: String(fields.by ?? "none") }), 1)
        yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, "smithers.work.outcome": outcome })
        yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")("work.links").pipe(
          Effect.annotateLogs({ ...fields, status: response.status, durationMs: (yield* Clock.currentTimeMillis) - startedAt }),
        )
        return response
      }).pipe(Effect.withSpan("work.links", { kind: "server" }))

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const path = request.url.split("?")[0]!
      if (path === GITHUB_WEBHOOK_ROUTE) return yield* webhook
      if (path === WRITES_SHAPE_ROUTE) return yield* ownWrites
      // A repository's edges whose parent the reader may also read, recomputed per request (decision 0153 rule 9).
      if (path === ISSUE_EDGES_SHAPE_ROUTE) {
        const named = shapeTarget(request.url)
        if (Result.isFailure(named)) return named.failure
        const readable = yield* readableSet(named.success)
        if (readable._tag === "Refused") return refusalOf(readable.proof as Access.Proof & { readonly _tag: "Refused" })
        const params: Record<string, string> = { "1": named.success.id }
        readable.ids.forEach((id, index) => void (params[String(index + 2)] = id))
        const list = readable.ids.map((_, index) => `$${index + 2}`).join(", ")
        return yield* shape(ISSUE_RELATIONS_TABLE, ISSUE_EDGE_COLUMNS, `child_repo_id = $1 AND parent_repo_id IN (${list})`, params)
      }
      // A repository's issues, comments, sync and triage, its pull requests and a head's checks (the runs on a
      // commit): the repository `?repo=` names, its own unless it names one (decision 0079, slice 1b).
      const repositoryShape = REPOSITORY_SHAPES[path]
      if (repositoryShape !== undefined) {
        const named = shapeTarget(request.url)
        if (Result.isFailure(named)) return named.failure
        const target = named.success
        const params = new URL(request.url, "http://localhost").searchParams
        const selected = itemShape(path, repositoryShape.where, target.id, params.get("number"))
        const refresh = params.get("refresh")
        // A pull's commits, reviews or checks with `?refresh=<number>` also refresh that pull from GitHub.
        const refreshes = refresh !== null && (path === PULL_COMMITS_SHAPE_ROUTE || path === REVIEWS_SHAPE_ROUTE || path === CHECKS_SHAPE_ROUTE)
        const refreshed = refreshes ? issueNumberOf(refresh) : undefined
        // Admission runs beside the shape read inside this request, bounded at `RECONCILE_START_TIMEOUT`.
        // Reconcile's work stays on the durable engine; no admission outlives the request (decision 0104).
        const reconciles = path === ITEMS_SHAPE_ROUTE || path === ITEM_SUMMARIES_SHAPE_ROUTE
        const validate = Effect.succeed(selected !== undefined && (!refreshes || refreshed !== undefined))
        const { proof, settled } = yield* access.repositoryReadable(
          target,
          "session",
          reconciles ? { validate, alongside: reconcileIfStale(target) } : { validate },
        )
        if (proof._tag === "Refused") {
          // Where an About read found the App absent lately, and Smithers knows no installation, the deployment doesn't
          // sync the repository: `404 app_not_installed`, which the page shows as GitHub's list. A viewer's refusal is
          // counted and logged as the read's, except a refresh's, which never was.
          const counted = proof.refusal === "app_not_installed" || (proof.stage === "viewer" && !refreshes)
          if (counted) {
            yield* Metric.update(
              Metric.withAttributes(Metrics.shapes, { table: repositoryShape.table, status: String(proof.status), live: "false" }),
              1,
            )
          }
          if (proof.refusal === "app_not_installed") {
            yield* Effect.logInfo(`github.shape.${repositoryShape.table}`).pipe(
              Effect.annotateLogs({ status: 404, errorCode: "app_not_installed", repoId: target.id }),
            )
          } else if (counted) {
            yield* Effect.logWarning(`github.shape.${repositoryShape.table}`).pipe(Effect.annotateLogs({ status: proof.status }))
          }
          yield* settled
          return refusalOf(proof)
        }
        const read = shape(repositoryShape.table, repositoryShape.columns, selected!.where, selected!.params)
        if (refreshed !== undefined) {
          const [, response] = yield* Effect.all([refreshPull.start(target, refreshed), read], { concurrency: 2 })
          const receipt = yield* refreshPull.receipt(target, refreshed)
          return HttpServerResponse.setHeader(response, PULL_RECEIPT_HEADER, receipt)
        }
        const response = yield* read
        yield* settled
        return response
      }
      if (path === ACTIONS_SHAPE_ROUTE) {
        const named = new URL(request.url, "http://localhost").searchParams.get("repo")
        const [owner = "", name = "", ...rest] = (named ?? `${repository.owner}/${repository.name}`).split("/")
        if (rest.length !== 0 || !isRepository(owner, name)) return refuse(400, "invalid")
        // The repository shapes' predicate (devpriv FINAL step 5): the deployment acts on it and the App isn't absent
        // there, then the viewer. Refusals are counted and logged as the shapes count theirs.
        const target = repositoryOf(`${owner}/${name}`)
        const { proof } = yield* access.repositoryReadable(target, "session")
        if (proof._tag === "Refused") {
          if (proof.refusal === "app_not_installed" || proof.stage === "viewer") {
            yield* Metric.update(Metric.withAttributes(Metrics.shapes, { table: RUNS_TABLE, status: String(proof.status), live: "false" }), 1)
            yield* Effect.logWarning(`github.shape.${RUNS_TABLE}`).pipe(Effect.annotateLogs({ status: proof.status }))
          }
          return refusalOf(proof)
        }
        return yield* shape(RUNS_TABLE, ACTION_COLUMNS, "repo_id = $1 AND execution IS NOT NULL", { "1": target.id })
      }
      // Any repository the person may read: a published branch's comparison lives on its own (docs/features/branch-publish.md).
      const compared = Compare.parseComparePath(path)
      if (compared !== undefined) {
        if (request.method !== "GET") return HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } })
        if (!isRepository(compared.owner, compared.name)) return refuse(404, "not_found")
        const target = repositoryOf(`${compared.owner}/${compared.name}`)
        // The repository shapes' predicate (devpriv FINAL step 5): the App's absence refuses too, as for the shapes.
        const { proof } = yield* access.repositoryReadable(target, "session")
        if (proof._tag === "Refused") return refusalOf(proof)
        if (Option.isNone(compare)) return refuse(503, "not_configured")
        return yield* compare.value(target, compared.base, compared.head).pipe(
          Effect.provide(database),
          Effect.catchCause(() => Effect.succeed(refuse(503, "unavailable"))),
        )
      }
      const reviewed = Review.parseReviewPath(path)
      if (reviewed !== undefined) return yield* review(reviewed)
      const listed = IssueList.parseIssuesPath(path)
      if (listed !== undefined) return yield* issues(listed)
      const scoped = TreeScope.parseTreeScopePath(path)
      if (scoped !== undefined) return yield* treeScope(scoped)
      const painting = FirstPaint.parseFirstPaintPath(path)
      if (painting !== undefined) return yield* firstPaint(painting)
      const linked = WorkLinks.parseLinksPath(path)
      if (linked !== undefined) return yield* links(linked)
      const target = parseWritesPath(path)
      if (target !== undefined) {
        const machine = MachineWrite.carriesMachineToken(yield* HttpServerRequest.HttpServerRequest)
        return yield* machine ? machineWrites(target) : writes(target)
      }
      const machineWrite = parseMachineWritePath(path)
      if (machineWrite !== undefined) return yield* machineWriteStatus(machineWrite)
      return HttpServerResponse.empty({ status: 404 })
    })

    /**
     * Whether the deployment syncs repository `target`'s issues and pull requests, as its shapes' `404` says, for anyone
     * (decision 0079 slice 1b): its own; another the allowed list keeps, where an About read didn't find the App absent.
     * Postgres not answering leaves it synced: the shapes then answer for themselves.
     */
    const maySync = (target: Repository) =>
      target.id === repository.id
        ? Effect.succeed(true)
        : !mayAct(target.id)
        ? Effect.succeed(false)
        : Store.appAbsent(target.id).pipe(Effect.provide(database), Effect.map((absent) => !absent), Effect.orElseSucceed(() => true))

    /**
     * The role route's `readable` (worker/home/Api.ts): whether the request may read `target`'s content by the shapes'
     * predicate (devpriv FINAL step 5), the deployment's checks included, so it never says a repository the deployment
     * doesn't act on, or where the App is absent, is readable. A check that couldn't decide (Postgres or GitHub not
     * answering) is `unavailable`, never `false`. A metadata 404 is a definite denial, identical for absent and
     * inaccessible repositories, so the client's data gate receives `false`.
     */
    const mayRead = (target: Repository) =>
      Effect.map(access.repositoryReadable(target, "session"), ({ proof }) =>
        proof._tag === "Readable" ? true
        : proof.status === 503 ? { unavailable: true as const, retryAfterSeconds: proof.retryAfterSeconds }
        : false)

    return { fetch, mayRead, maySync }
  })
