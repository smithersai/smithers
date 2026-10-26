import { COMMITMENTS, commitmentLabel } from "../../src/features/issues/lifecycle.ts"
import { triageOf } from "../../src/features/issues/contract.ts"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Core, GitHub } from "@smthrs/integrations"
import { Node } from "@smthrs/plan"
import { Clock, Effect, Layer, Metric, Option, type Redacted, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  ACCEPTED_LABEL,
  agentAttribution,
  labelOf,
  NOT_ACCEPTED_LABEL,
  TRIAGE_LABEL_COLORS,
  type WriteFailure,
} from "../../src/features/issues/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import type { Services } from "./Apply.ts"
import { roleOf } from "../GitHubAuth.ts"
import { classify, withToken } from "./Calls.ts"
import { repositoryOf } from "./Config.ts"
import * as Metrics from "./Metrics.ts"
import { fetchIssue, project } from "./Project.ts"
import { permissionOf } from "./RepoRoles.ts"
import * as Store from "./Store.ts"
import type { TokenUnavailable } from "./Tokens.ts"
import * as TriageStore from "./TriageStore.ts"

// `github/Write { writeId }` (decision 0012 §4, docs/features/issues.md#writes): the one remote flow behind every git
// write. The writes route admitted the write and recorded it in `github_writes`; this calls GitHub once and settles the
// row and the projection together. A person's own write runs with their GitHub token, so GitHub shows them; the agent's
// runs as the App and its text says whom it acted for (§5). It runs remotely because it needs a token the person must
// not hold in the browser (decision 0011 §2).
//
// Triage's writes go the same way (§5): a person's Accept or Not accepted (`issue/triage`) labels with their own token,
// comments their reason when they give one, and pins the issue against the flow; Enable and Pause (`triage/enable`,
// `triage/pause`) change only the repository's settings, so they call GitHub not at all.
//
//   send: token ─▶ count the attempt ─▶ Action.once: find our marker on GitHub, else one POST carrying it
//         ─▶ read the issue back ─▶ settle `done` with the rows, in one transaction
//         GitHub refused ─▶ settle `refused`; a lost answer or an outage ─▶ retried; past the retries ─▶ settle `failed`
//
// Every created issue and comment carries `<!-- smithers:write=<id> -->`, the write's own id as `Action.once`'s key
// (GitHub.Once.issue, GitHub.Once.comment), so every attempt, after a lost answer or a crash before the step sealed,
// finds what an earlier one made instead of writing it again, and the projection joins the item to its write.
//
// A person's Accept or Not accepted wins over the triage flow whatever order the labels land in. Admitted, the write
// pins the issue (`TriageStore.itemTriage`), so a flow decision checked after that drops; and the write waits until no
// flow label or comment checked before it is still writing (`TriageStore.flowWriteInFlight`), so its labels land last.

/** GitHub or Postgres couldn't answer, or the answer was lost. Retried, after `retryAfterMillis`. */
export class WriteUnavailable extends Schema.TaggedError<WriteUnavailable>()("@smthrs/mvp/github/WriteUnavailable", {
  retryAfterMillis: Schema.optional(Schema.Number),
}) {}

/** 1 s doubling to a minute, for at most an hour: GitHub's rate limits and short outages pass within it. */
export const WRITE_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 60 * 60_000 })

/** Settling a failed write: while Postgres is unreachable, never giving up. */
export const GIVE_UP_RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000 })

/** How far before a write's admission an issue search looks: GitHub's `since` is by update time, at a second's grain. */
export const MARKER_SLACK_MS = 60_000

/**
 * `send`'s implementation version. v2 (2026-10-21) writes issues and comments through `Action.once` keyed by the write
 * id, and a person's triage waits for a flow write in flight; a run parked on a v1 plan stops with `plan_changed`
 * rather than resume under different recovery.
 */
export const SEND_VERSION = "github-write/send/v2"

/** How long a person's triage waits before it looks again for a flow write in flight. */
export const LABEL_WAIT_MS = 1_000

const WriteRequest = { writeId: Schema.String.check(Schema.isUUID()) }

/** How the write ended. */
export const Written = Schema.Struct({
  status: Schema.Literals(["done", "refused", "failed", "missing"]),
  itemNumber: Schema.NullOr(Schema.Number),
})
export type Written = typeof Written.Type

/**
 * The step: call GitHub once and settle. Every write it makes goes through `Action.once` or is idempotent, so a repeat
 * is safe: the durable engine re-runs an attempt that died mid-write, and `once` finds what it made.
 */
export const Send = Action.make("github/Write/send", {
  payload: WriteRequest,
  success: Written,
  error: WriteUnavailable,
  implementationVersion: SEND_VERSION,
  tier: "irreversible",
  idempotencyKey: ({ writeId }) => ({ write: writeId }),
  retryPolicy: WRITE_RETRY,
})

/** The step after the last failed attempt: settles the write `failed` `unavailable`. */
export const GiveUp = Action.make("github/Write/give-up", {
  payload: WriteRequest,
  success: Written,
  error: WriteUnavailable,
  retryPolicy: GIVE_UP_RETRY,
})

/** `github/Write`: makes one admitted git write on GitHub. */
export const Write = Flow.make("github/Write", {
  description: "Make one admitted git write on GitHub (open an issue, comment, a person's triage) or to the " +
    "repository's triage settings, and settle it with its rows.",
  capabilities: ["db:write:github_writes", "db:write:items", "db:write:comments", "db:write:triage_settings"],
  modelInvocable: false,
  payload: WriteRequest,
  success: Written,
  error: WriteUnavailable,
  body: Node.capture({ send: Send.name, giveUp: GiveUp.name }, (request) =>
    Send.call(request).pipe(Node.catch({ onFailure: () => GiveUp.call(request) }))),
})

/** The wait GitHub asked for, when a failure says so. */
const retryAfter = (error: unknown): { readonly retryAfterMillis?: number } => {
  const classified = classify(error)
  return classified.kind === "retry" && classified.retryAfterMillis !== undefined
    ? { retryAfterMillis: classified.retryAfterMillis }
    : {}
}

/** What a refused token means for the write: refused for good, or tried again. */
const tokenFailure = (failure: TokenUnavailable): WriteFailure | undefined =>
  failure.reason === "sign_in_required" || failure.reason === "app_not_installed" || failure.reason === "not_allowed"
    ? failure.reason
    : undefined

/** Which token a write runs with: none for the settings writes and the ops this flow refuses, else the actor's. */
const tokenKindOf = (write: Store.Write): "user" | "app" | "none" =>
  write.op === "triage/enable" || write.op === "triage/pause" || write.op === "triage/run" || write.op === "pr/merge" ||
    write.op === "branch/publish" || write.op === "branch/update" || write.op === "branch/resync"
    ? "none"
    : write.via === "person"
    ? "user"
    : "app"

/** What GitHub's refusal means for the write. A person's token GitHub won't take any more is a session to sign in again. */
const refusalOf = (status: number, token: "user" | "app"): WriteFailure =>
  status === 401
    ? token === "user" ? "sign_in_required" : "unavailable"
    : status === 404 || status === 410
    ? "not_found"
    : status === 422
    ? "invalid"
    : "not_allowed"

/** What a settled write answers: what it settled, whichever run settled it. */
const answerOf = (status: Exclude<Store.Write["status"], "pending">, itemNumber: number | null): Written => ({
  status,
  itemNumber: status === "done" ? itemNumber : null,
})

/** The steps over `services`, each recording what it did: never a title, a body, a login or a token. */
export const steps = <E, R>(services: Services<E, R>) => {
  const settled = (
    write: Store.Write,
    token: "user" | "app" | "none",
    settlement: Store.Settlement,
    project?: Effect.Effect<unknown, unknown, unknown>,
  ) =>
    Effect.gen(function* () {
      // `tokenKind`, never `token`: the flow host's redaction hides the value of a field named `token`.
      const fields = { writeId: write.id, op: write.op, via: write.via, tokenKind: token }
      const settledNow = yield* Store.settleWrite(write.id, settlement, project as Effect.Effect<unknown> | undefined)
      if (settledNow) {
        yield* Metric.update(Metric.withAttributes(Metrics.writes, { op: write.op, outcome: settlement.status, token }), 1)
        yield* Metric.update(Metric.withAttributes(Metrics.writeMs, { op: write.op }), (yield* Clock.currentTimeMillis) - write.createdAt)
      }
      yield* Effect.logWithLevel(settlement.status === "done" ? "Info" : "Warn")("github.write").pipe(
        Effect.annotateLogs({
          ...fields,
          outcome: settlement.status,
          settled: settledNow,
          ...(settlement.status === "done" ? { number: settlement.itemNumber } : { failure: settlement.failure }),
        }),
      )
      return {
        status: settlement.status,
        itemNumber: settlement.status === "done" ? settlement.itemNumber : null,
      } satisfies Written
    })

  const send = ({ writeId }: typeof Send.payloadSchema.Type) =>
    Effect.gen(function* () {
      const found = yield* Store.writeOf(writeId)
      if (Option.isNone(found)) {
        yield* Effect.logWarning("github.write").pipe(Effect.annotateLogs({ writeId, outcome: "missing" }))
        return { status: "missing", itemNumber: null } satisfies Written
      }
      const write = found.value
      // A run started again after it settled answers what it settled.
      if (write.status !== "pending") return answerOf(write.status, write.itemNumber)
      const repository = repositoryOf(write.repoId.replace(/^github\//, ""))
      const payload = write.payload
      // Enabling and pausing triage change the repository's settings and nothing on GitHub: no token.
      if (payload.op === "triage/enable" || payload.op === "triage/pause") {
        return yield* settled(
          write,
          "none",
          { status: "done", itemNumber: null, githubId: null },
          payload.op === "triage/enable"
            ? TriageStore.enable(write.repoId, { actorId: write.actorId, login: write.login, dailyTokens: payload.dailyTokens })
            : TriageStore.pause(write.repoId, "person"),
        )
      }
      // Run triage again is admitted for `triage/Run`, which settles it; this flow never runs one.
      if (payload.op === "triage/run") return yield* settled(write, "none", { status: "refused", failure: "invalid" })
      // A merge is admitted for `pr/Merge` (worker/github/Merge.ts), which settles it; this flow never runs one.
      if (payload.op === "pr/merge") return yield* settled(write, "none", { status: "refused", failure: "invalid" })
      // Publish, Update branch and Resync are admitted for `branch/Publish`, `branch/Update` and `branch/Resync`
      // (worker/branch/Publish.ts).
      if (payload.op === "branch/publish" || payload.op === "branch/update" || payload.op === "branch/resync") {
        return yield* settled(write, "none", { status: "refused", failure: "invalid" })
      }
      const kind = write.via === "person" ? "user" as const : "app" as const
      // A person's triage writes after every flow label or comment that passed its pin check before this write was
      // admitted.
      if (payload.op === "issue/triage" && (yield* TriageStore.flowWriteInFlight(write.repoId, payload.number))) {
        yield* Effect.logInfo("github.write").pipe(
          Effect.annotateLogs({ writeId, op: write.op, tokenKind: kind, outcome: "waiting", waitingFor: "flow_write" }),
        )
        return yield* new WriteUnavailable({ retryAfterMillis: LABEL_WAIT_MS })
      }
      const token = yield* (write.via === "person"
        ? services.tokens.forSession(write.sessionId!)
        : services.tokens.forInstallation(repository, "write")).pipe(Effect.result)
      if (token._tag === "Failure") {
        const failure = tokenFailure(token.failure)
        if (failure !== undefined) return yield* settled(write, kind, { status: "refused", failure })
        return yield* new WriteUnavailable(
          token.failure.retryAfterMillis === undefined ? {} : { retryAfterMillis: token.failure.retryAfterMillis },
        )
      }
      /** A body as GitHub gets it: the agent's says whom it acted for. `GitHub.Once` adds the write's marker. */
      const attributed = (text: string) =>
        write.via === "agent" ? `${text}\n\n${agentAttribution(write.login ?? "unknown")}` : text
      /** Keyed by the write's own id, which the route recorded before the flow started and the projection joins on. */
      const keyed = { key: write.id }
      // The triage state the issue had before a person's override: what the override metric counts it from.
      const before = payload.op === "issue/triage"
        ? Option.match(yield* TriageStore.itemTriage(write.repoId, payload.number), {
          onNone: () => "proposed" as const,
          onSome: (item) => item.triage,
        })
        : "proposed"
      const onGitHub = (accessToken: Redacted.Redacted<string>) =>
        Effect.gen(function* () {
          // Counted for the write's record; `Action.once` decides what was made, by the write's marker alone.
          yield* Store.beginAttempt(write.id)
          // The agent writes as the App, so GitHub checks nothing of the person: each attempt checks again that they
          // are still a Member or above there, as the account sign-in knows (decisions 0007 §6 and 0079). A person's
          // own write goes with their own token, which GitHub checks.
          const actsForMember = write.via !== "agent" ? Effect.succeed(true) : Effect.gen(function* () {
            // Store.writeOf reads both NOT NULL people columns through the same LEFT JOIN.
            if (write.login === null) return false
            const permission = yield* GitHub.Collaborators.permission(repository.owner, repository.name, write.login)
            if (Option.isNone(permission) || permission.value.userId !== write.accountId) return false
            const role = roleOf(permissionOf(permission.value))
            return role === "admin" || role === "maintainer" || role === "member"
          })
          // Recovery may adopt an earlier write after permission was revoked; only a new POST needs authority.
          const authorized = <A, E, R>(operation: Action.Keyed<A, E, R>) => Action.keyed({
            find: operation.find,
            perform: (key: string) => Effect.gen(function* () {
              if (!(yield* actsForMember)) return yield* Effect.fail(new Core.IntegrationError.IntegrationError(
                "delivery-failed", "The account may no longer write to this repository.", { status: 403 },
              ))
              return yield* operation.perform(key)
            }),
          })
          const comment = (number: number, text: string) =>
            Effect.map(
              Action.once("comment", authorized(GitHub.Once.comment(repository.owner, repository.name, number, attributed(text))), keyed),
              (made) => ({ number, githubId: made.id }),
            )
          if (payload.op === "issue/create") {
            const since = new Date(write.createdAt - MARKER_SLACK_MS).toISOString()
            const issue = yield* Action.once(
              "issue",
              authorized(GitHub.Once.issue(repository.owner, repository.name, { title: payload.title, body: attributed(payload.body), since })),
              keyed,
            )
            return { number: issue.number, githubId: issue.id }
          }
          if (payload.op === "issue/comment") return yield* comment(payload.number, payload.body)
          if (payload.op === "issue/commitment") {
            const permission = write.login === null ? Option.none() : yield* GitHub.Collaborators.permission(repository.owner, repository.name, write.login)
            const maintains = Option.isSome(permission) &&
              [permission.value.roleName, permission.value.permission].some((role) => role === "admin" || role === "maintain")
            const issue = yield* GitHub.Issues.getIssue(repository.owner, repository.name, payload.number)
            if (write.via !== "person" || !maintains || triageOf(issue.labels.map((label) => label.name)) !== "accepted")
              return { number: payload.number, githubId: null, refused: true }
            const add = commitmentLabel(payload.commitment)
            yield* GitHub.Issues.createLabel(repository.owner, repository.name, { name: add, color: "1d76db" })
            yield* GitHub.Issues.addLabels(repository.owner, repository.name, payload.number, [add])
            for (const other of COMMITMENTS) if (other !== payload.commitment)
              yield* GitHub.Issues.removeLabel(repository.owner, repository.name, payload.number, commitmentLabel(other))
            return { number: payload.number, githubId: null }
          }
          // A person's Accept or Not accepted: one triage label on, the other off (each idempotent, so a repeat is
          // harmless), then their reason as their own comment when they gave one.
          const add = labelOf(payload.decision)
          yield* GitHub.Issues.createLabel(repository.owner, repository.name, { name: add, color: TRIAGE_LABEL_COLORS[add]! })
          yield* GitHub.Issues.addLabels(repository.owner, repository.name, payload.number, [add])
          yield* GitHub.Issues.removeLabel(
            repository.owner,
            repository.name,
            payload.number,
            add === ACCEPTED_LABEL ? NOT_ACCEPTED_LABEL : ACCEPTED_LABEL,
          )
          if (payload.reason === null) return { number: payload.number, githubId: null }
          return yield* comment(payload.number, payload.reason)
        }).pipe(withToken(accessToken, services.apiBaseUrl))
      const made = yield* onGitHub(token.success).pipe(Effect.result)
      if (made._tag === "Failure") {
        const classified = classify(made.failure)
        if (classified.kind === "refused") {
          return yield* settled(write, kind, { status: "refused", failure: refusalOf(classified.status, kind) })
        }
        if (classified.kind === "unknown") {
          yield* Metric.update(Metric.withAttributes(Metrics.writeUnknown, { op: write.op }), 1)
        }
        yield* Effect.logWarning("github.write").pipe(
          Effect.annotateLogs({ writeId, op: write.op, tokenKind: kind, outcome: classified.kind, errorCode: codeOf(made.failure) }),
        )
        return yield* new WriteUnavailable(retryAfter(made.failure))
      }
      // GitHub took it: read the issue back, then settle the write with its rows in one transaction. A read-back that
      // fails is tried again; the next attempt finds the write by its marker.
      const result = made.success
      if ("refused" in result && result.refused) return yield* settled(write, kind, { status: "refused", failure: "not_allowed" })
      const fetched = yield* fetchIssue(repository, result.number).pipe(withToken(token.success, services.apiBaseUrl))
      const projected = project(repository, result.number, fetched)
      const written = yield* settled(
        write,
        kind,
        { status: "done", itemNumber: result.number, githubId: result.githubId },
        payload.op === "issue/triage"
          // The override pins the issue, so the flow drops a decision in flight and never re-decides it, and is recorded
          // as the person's decision with its receipts.
          ? Effect.gen(function* () {
            yield* projected
            yield* TriageStore.pin(write.repoId, payload.number, true)
            yield* TriageStore.recordDecision({
              id: write.id,
              repoId: write.repoId,
              number: payload.number,
              via: "person",
              decidedBy: write.actorId,
              runId: null,
              writeId: write.id,
              guidelinesSha: null,
              inputDigest: null,
              triageBefore: before,
              decision: payload.decision,
              reason: null,
              abstained: null,
              tokens: 0,
              labeled: true,
              commentGithubId: result.githubId,
            })
          })
          : projected,
      )
      if (payload.op === "issue/triage" && written.status === "done") {
        yield* Metric.update(Metric.withAttributes(Metrics.triageDecisions, { decision: payload.decision, via: "person" }), 1)
        yield* Metric.update(Metric.withAttributes(Metrics.triageOverrides, { from: before, to: payload.decision }), 1)
      }
      return written
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, services.http),
      Effect.provide(services.database),
      Effect.catch((error) =>
        error instanceof WriteUnavailable
          ? Effect.fail(error)
          : Effect.logWarning("github.write").pipe(
            Effect.annotateLogs({ writeId, outcome: "failed", errorCode: codeOf(error) }),
            Effect.andThen(Effect.fail(new WriteUnavailable(retryAfter(error)))),
          )
      ),
      Effect.withSpan("github.write", { attributes: { "smithers.github.write": writeId } }),
    )

  const giveUp = ({ writeId }: typeof GiveUp.payloadSchema.Type) =>
    Effect.gen(function* () {
      const found = yield* Store.writeOf(writeId)
      if (Option.isNone(found)) return { status: "missing", itemNumber: null } satisfies Written
      // A write another run settled answers what it settled, never `failed`.
      if (found.value.status !== "pending") return answerOf(found.value.status, found.value.itemNumber)
      return yield* settled(found.value, tokenKindOf(found.value), { status: "failed", failure: "unavailable" })
    }).pipe(
      Effect.provide(services.database),
      Effect.mapError(() => new WriteUnavailable({})),
      Effect.withSpan("github.write.give_up", { attributes: { "smithers.github.write": writeId } }),
    )

  return { send, giveUp }
}

/** Registers `github/Write` with its steps over `services`. */
export const registration = <E, R>(services: Services<E, R>) => {
  const implementation = steps(services)
  return Interpreter.layerWithImplementations(
    Write,
    Layer.merge(
      Send.toLayer(implementation.send, { implementationVersion: SEND_VERSION }),
      GiveUp.toLayer(implementation.giveUp),
    ),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}
