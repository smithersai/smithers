import * as WriteAuthority from "../WriteAuthority.ts"
import { ShapeProxy } from "@smthrs/effect-electric"
import { Binding } from "@smthrs/secrets"
import { Cause, Clock, Effect, Metric, Option, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { LOCAL_ELECTRIC_URL } from "../../src/features/chat/contract.ts"
import { repoId } from "../../src/features/repo/contract.ts"
import {
  MAX_PUT_BODY_BYTES,
  parseSecretRoute,
  type Refusal,
  SECRETS_SHAPE_COLUMNS,
  SECRETS_SHAPE_ROUTE,
  SECRETS_TABLE,
  writeExecutionId,
} from "../../src/features/secrets/contract.ts"
import { type Actor, canAsk, refusesPersonOnly, Sessions } from "../Actor.ts"
import { readBounded } from "../Body.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Flows from "../Flows.ts"
import * as ShapeAccess from "../ShapeAccess.ts"
import { SecretKeys } from "./Keys.ts"
import * as SecretFlows from "./SecretFlows.ts"

// The secrets routes (decision 0005 §4, docs/features/secrets.md#routes). Values are write-only: no route answers one.
//
// - `PUT /api/repos/<owner>/<name>/secrets/<NAME> { value, hosts, methods? }`: sets or replaces a secret. It admits the
//   write (signed in; an Admin acting in person, never an agent, flow or sandbox: 0007 `repo:secret-write`; the
//   repository sign-in reads roles on, since a session carries one role), checks the name, the hosts and the value,
//   seals the value under SECRETS_KEY, and starts `secret/Put` with only the ciphertext.
//   Hosts change only with a value, so whoever binds a secret to a host knows the value already.
// - `DELETE` the same path: deletes it through `secret/Delete`.
// - `GET /api/shapes/secrets?repo=<repo id>`: the repository's names, hosts and methods, for a Member or above of the
//   repository sign-in reads roles on, never the ciphertext.
//
// No log line, span, metric or answer carries a value, and a refusal names a code, never the input.

/** Secret route requests, by `op` (`put`, `delete`) and `outcome`. */
export const requests = Metric.counter("smithers_secret_requests", {
  description: "Requests to the secrets routes, by op and outcome",
  incremental: true,
})

/** `GET /api/shapes/secrets` requests, by `status` and `live`. */
export const shapes = Metric.counter("smithers_secret_shape_requests", {
  description: "GET /api/shapes/secrets requests, by status and live",
  incremental: true,
})

/** Whether a path is one of the secrets routes. */
export const handles = (path: string): boolean => path === SECRETS_SHAPE_ROUTE || parseSecretRoute(path) !== undefined

const PutBody = Schema.Struct({
  value: Schema.String,
  hosts: Schema.Array(Schema.String),
  methods: Schema.optional(Schema.Array(Schema.String)),
})
const decodePut = Schema.decodeUnknownEffect(Schema.fromJsonString(PutBody))
const decodeBinding = Schema.decodeUnknownEffect(Binding.Binding)
const isName = Schema.is(Binding.Name)

/** What a shape filters on for someone who may not read names: no repository, so it holds no rows. */
const NO_REPO = ""

const noStore = { "cache-control": "no-store" }

type Fields = Record<string, string | number | boolean>

/** Whether `actor` may write secrets: an Admin acting in person. */
export const mayWrite = (actor: Actor): boolean => actor.act === undefined && actor.role === "admin"

/**
 * The secrets routes for `repository`, the one sign-in reads roles on (`GITHUB_REPOSITORY`): any other repository's
 * secrets are `not_found`. They read the keys from `SecretKeys`, who is asking from `Sessions`, and start the flows
 * through `Flows.FlowStarter`.
 */
export const make = (repository: { readonly id: string }) => Effect.gen(function* () {
  const connection = yield* ShapeProxy.config({ url: LOCAL_ELECTRIC_URL })

  /** `GET /api/shapes/secrets?repo=<repo id>`: names, hosts and methods only; sessions unreadable, 503. */
  const shape = ShapeProxy.make({
    ...connection,
    shape: Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const named = new URL(request.url, "http://localhost").searchParams.get("repo") ?? NO_REPO
      const actor = yield* ShapeAccess.actor
      const repo = Option.isSome(actor) && canAsk(actor.value) && named.toLowerCase() === repository.id
        ? repository.id
        : NO_REPO
      return { table: SECRETS_TABLE, where: "repo_id = $1", params: { "1": repo }, columns: SECRETS_SHAPE_COLUMNS }
    }),
    name: "secret.shape",
    metric: shapes,
  })

  /** `PUT` and `DELETE /api/repos/<owner>/<name>/secrets/<NAME>`. */
  const write = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const sessions = yield* Sessions
    const starter = yield* Flows.FlowStarter
    const keys = yield* SecretKeys
    const startedAt = yield* Clock.currentTimeMillis
    const op = request.method === "DELETE" ? "delete" : "put"
    const fields: Fields = { op }
    const refuse = (status: number, code: Refusal) => {
      fields.code = code
      return HttpServerResponse.jsonUnsafe({ code }, { status, headers: noStore })
    }
    const response = yield* Effect.gen(function* () {
      if (request.method !== "PUT" && request.method !== "DELETE") {
        return HttpServerResponse.empty({ status: 405, headers: { allow: "PUT, DELETE" } })
      }
      const route = parseSecretRoute(request.url.split("?")[0]!)!
      if (Option.isNone(keys)) return refuse(503, "off")
      const actor = yield* sessions.resolve
      if (Option.isNone(actor)) return refuse(401, "authentication")
      // A secret is a protected act: anyone acting for the person is refused, and counted as such (decision 0017).
      if (yield* refusesPersonOnly(actor.value, "secret")) return refuse(403, "forbidden")
      if (!mayWrite(actor.value)) return refuse(403, "forbidden")
      const repo = repoId(route.owner, route.name)
      if (repo !== repository.id) return refuse(404, "not_found")
      if (!isName(route.secret)) return refuse(400, "invalid_name")
      fields.repoId = repo
      fields.name = route.secret
      const executionId = writeExecutionId(op, crypto.randomUUID())
      if (op === "delete") {
        const started = yield* starter.start(SecretFlows.Delete, {
          executionId,
          payload: { authority: WriteAuthority.sessionOf(actor.value) ?? null, repoId: repo, name: route.secret, actorId: actor.value.subject.id },
        }).pipe(Effect.result)
        if (started._tag === "Failure") return refuse(503, "unavailable")
        fields.outcome = "deleting"
        return HttpServerResponse.jsonUnsafe({ name: route.secret }, { status: 202, headers: noStore })
      }
      const body = yield* readBounded(request, MAX_PUT_BODY_BYTES).pipe(Effect.result)
      if (body._tag === "Failure") {
        return body.failure.reason === "too_large" ? refuse(413, "too_large") : refuse(400, "invalid")
      }
      // A decoding failure would quote its input, the value: it is dropped whole.
      const decoded = yield* decodePut(body.success).pipe(Effect.option)
      if (Option.isNone(decoded)) return refuse(400, "invalid")
      const binding = yield* decodeBinding({
        name: route.secret,
        hosts: decoded.value.hosts,
        ...(decoded.value.methods === undefined ? {} : { methods: decoded.value.methods }),
      }).pipe(Effect.option)
      if (Option.isNone(binding)) return refuse(400, "invalid_hosts")
      const problem = Binding.valueProblem(decoded.value.value)
      if (problem !== undefined) return refuse(400, problem)
      const { cipher, version } = keys.value
      const sealed = yield* cipher.seal(Redacted.make(decoded.value.value), { id: repo, name: route.secret, version })
      const started = yield* starter.start(SecretFlows.Put, {
        executionId,
        payload: {
          authority: WriteAuthority.sessionOf(actor.value) ?? null,
          repoId: repo,
          name: route.secret,
          sealed,
          keyVersion: version,
          hosts: binding.value.hosts,
          ...(binding.value.methods === undefined ? {} : { methods: binding.value.methods }),
          actorId: actor.value.subject.id,
        },
      }).pipe(Effect.result)
      if (started._tag === "Failure") return refuse(503, "unavailable")
      fields.outcome = "putting"
      fields.hosts = binding.value.hosts.length
      return HttpServerResponse.jsonUnsafe({ name: route.secret }, { status: 202, headers: noStore })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          fields.errorCode = codeOf(Cause.squash(cause))
          return refuse(503, "unavailable")
        })
      ),
    )
    fields.status = response.status
    fields.durationMs = (yield* Clock.currentTimeMillis) - startedAt
    const outcome = String(fields.outcome ?? fields.code ?? "refused")
    yield* Metric.update(Metric.withAttributes(requests, { op, outcome }), 1)
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, outcome })
    yield* Effect.logWithLevel(response.status >= 500 ? "Error" : response.status >= 400 ? "Warn" : "Info")(
      "secret.request",
    ).pipe(Effect.annotateLogs({ ...fields, outcome }))
    return response
  }).pipe(Effect.withSpan("secret.request", { kind: "server" }))

  const fetch = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    return request.url.split("?")[0] === SECRETS_SHAPE_ROUTE ? yield* shape : yield* write
  })

  return { fetch }
})
