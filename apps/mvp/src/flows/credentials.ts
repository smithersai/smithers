import { Flow, FlowRuntime } from "@smthrs/flow"
import { EngineStore } from "@smthrs/flows"
import { Cache, Context, Data, Duration, Effect, Exit, Layer, Metric, Option, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { codeOf } from "../errorCode"
import { asker } from "./askingTab"
import { withBearer, withoutCookie } from "./bearer"
import { CREDENTIAL_TTL_MS, credentialRoute, doorChannel, PERSON_DOORS } from "./contract"
import { DoorAnswer, type DoorCall } from "./doors"
import { refusesCredential } from "./personOnly"
import { FlowRegistry } from "./registry"
import { requesterOf } from "./requests"

// Run credentials on the device (decision 0017 slice 0, docs/features/sign-in.md#run-credentials). The engine, which is
// compiled-in application code, decides who each request acts as; the model, realm code and frames never choose. A
// request a run makes to ChatApi goes with the person's session only when the run is the person's own press: a root
// run of a person's flow (the registry's `acts` unset) that the tab started through a person door (`PERSON_DOORS`).
// The compiled branch-operation subflows and continuations retain their Publish/Update caller’s session.
// A resumed root can recover its person door from the engine’s persisted origin. Every other run sends
// a credential the server minted for that very run, and its session
// cookie never rides along (`credentials: "omit"`). A nested run's credential is minted under its parent's, so the
// server narrows it at every hop and refuses one a person-only flow or a wider callee asks for; that refusal is the
// request's answer. A run whose person is signed out sends its requests with no credential at all; a root run whose
// tab says nobody is signed in doesn't ask for one either, since the server could only refuse it.
//
// A root run of a flow whose route only the person may use (`refusesCredential`: `notification/ack`, `run/answer`, …)
// whose tab doesn't answer in time goes in the session too: dispatch starts one only through a person door
// (src/flows/dispatch.ts), and nothing else starts one (Retry runs no person-only flow), so it is the person's own press
// whose tab is busy, or was reloaded while the engine resumed it. Minting for it would only be refused, every time.
// A tab that answers with another door is still refused.

/** How long before a credential ends the engine mints the next. */
export const RENEW_BEFORE_MS = 60 * 1000

/** How long the engine waits for the tab that started a root run to say which door it came through. */
export const DOOR_WITHIN = "2 seconds"

/** How long a signed-out run stays signed out before the engine asks again. */
export const ANONYMOUS_FOR_MS = 30 * 1000

/** The runs and credentials the engine remembers: far more than run at once. */
export const REMEMBERED = 1_024

/**
 * How a run's requests go: in the person's session (`Session`, their own press), with a token minted for the run, with
 * none because its person is signed out (`Anonymous`), or not at all, with the server's refusal as their answer.
 */
export type Credential =
  | { readonly _tag: "Session" }
  | { readonly _tag: "Token"; readonly token: string; readonly act: string }
  | { readonly _tag: "Anonymous" }
  | { readonly _tag: "Refused"; readonly status: number; readonly code: string }

const sessionCredential: Credential = { _tag: "Session" }
const anonymousCredential: Credential = { _tag: "Anonymous" }

/** The server couldn't be asked for a run's credential, or a run's lineage couldn't be read: nothing was sent. */
export class CredentialUnavailable extends Data.TaggedError("CredentialUnavailable")<{ readonly reason: string }> {}

/**
 * Credentials minted on this device, by `outcome` (`minted`, `anonymous`, `refused`, `unavailable`, `unreachable` for an
 * ask that never reached ChatApi, or `signed_out` for one not asked for because the run's tab said nobody is signed in)
 * and `act`.
 */
export const mints = Metric.counter("smithers_run_credential_mints", {
  description: "Run credentials this device's engine asked for, by outcome and act",
  incremental: true,
})

const Minted = Schema.Struct({ token: Schema.String, act: Schema.String })
const Refusal = Schema.Struct({ code: Schema.String })
const decodeMinted = Schema.decodeUnknownOption(Minted)
const decodeRefusal = Schema.decodeUnknownOption(Refusal)

/** Whether `flow` is a person's flow: registered, with no `acts` mark. */
const personFlow = (registry: FlowRegistry["Service"], flow: string): boolean =>
  Object.hasOwn(registry.entries, flow) && registry.entries[flow]!.acts === undefined

/**
 * The credentials of the runs on this engine, and the `HttpClient` its flows' steps use: `client` sends each request to
 * `origin`'s `/api/` as the run that made it, as above, and every other request as `base` would.
 */
export class RunCredentials extends Context.Service<
  RunCredentials,
  {
    /**
     * The current run's bearer token, for a request the tab sends for it (an agent's issue write): none for the
     * person's own press. Fails when the run has no credential to send: refused, signed out or unreachable.
     */
    readonly bearer: Effect.Effect<Option.Option<string>, CredentialUnavailable>
  }
>()("@smthrs/mvp/flows/RunCredentials") {}

/**
 * The engine's run credentials over `base` (the host's `HttpClient`), and the client its flows use, for ChatApi on
 * `origin`, asking the tabs of engine `name` which door a root run came through. `flows` are the declarations the
 * engine runs: each asks with its declared ceiling, its `Flow.make` capabilities, which the server only ever narrows
 * with. Needs the host's `RunInspection`, which says each run's flow and parent, and `TabChannel`.
 */
export const layer = (options: {
  readonly origin: string
  readonly name: string
  readonly flows: ReadonlyArray<Flow.Any>
}) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const registry = yield* FlowRegistry
      const ceilings = new Map(options.flows.map((flow) => [flow._tag, Flow.capabilityCeilings(flow.annotations)]))
      const base = yield* HttpClient.HttpClient
      const inspection = yield* EngineStore.RunInspection.RunInspection
      const askDoor = yield* asker<typeof DoorCall.Type, typeof DoorAnswer>({
        channel: doorChannel(options.name),
        output: DoorAnswer,
        within: DOOR_WITHIN,
      })

      const lineage = () => new CredentialUnavailable({ reason: "lineage" })

      /**
       * A run's flow and parent: the parent this engine recorded, else the run it is named after (`requesterOf`, the
       * app's one lineage rule: the agent's calls are `<answer>/…/call/…`, an answer's close `<answer>/close`) when this
       * engine holds such a run. A name like `ack/…` or `deliver/…` names no run, so that run is a root.
       */
      const runOf = (run: string) =>
        Effect.gen(function* () {
          const { run: summary } = yield* inspection.inspect(run, { limit: 1 }).pipe(Effect.mapError(lineage))
          const requester = requesterOf(run)
          if (summary.parentRunId !== null || requester === run) {
            return { flow: summary.flowName, parent: summary.parentRunId, origin: summary.origin }
          }
          const named = yield* inspection.payload(requester).pipe(
            Effect.as(true),
            // expected: a requester this engine never held names no parent
            Effect.catchTag("@smthrs/engine-store/RunNotFound", () => Effect.succeed(false)),
            Effect.mapError(lineage),
          )
          return { flow: summary.flowName, parent: named ? requester : null, origin: summary.origin }
        })

      /**
       * How run `run`'s requests go. The person's own press, a parentless run of a person's flow its tab started through
       * a person door (or whose tab is silent, for a flow only the person may run), goes in their session, for good.
       * Every root asks its tab, including flows marked as agents or flows. Any other run asks for a credential: in
       * the person's session when it has no parent or its parent is the person's press, else under its parent's,
       * which it gets first. A run under a parent that can't act gets nothing
       * more: the parent's refusal, or its signed-out state. A door nobody answered in time is a log line
       * `auth.run_credential` with `outcome: door_timeout`.
       */
      const credentials: Cache.Cache<string, Credential, CredentialUnavailable> = yield* Cache.makeWith(
        (run: string): Effect.Effect<Credential, CredentialUnavailable> =>
          Effect.gen(function* () {
            const { flow, parent, origin } = yield* runOf(run)
            let ownPress = false
            if (parent === null) {
              const answered = yield* askDoor(run, {})
              if (Option.isNone(answered)) {
                yield* Effect.logWarning("auth.run_credential").pipe(Effect.annotateLogs({ flow, outcome: "door_timeout" }))
              }
              ownPress = personFlow(registry, flow) && Option.match(answered, {
                onNone: () => refusesCredential(flow) || (origin?.actor === "person" && PERSON_DOORS.some((door) => door === origin.door)),
                onSome: (answer) => PERSON_DOORS.includes(answer.door),
              })
              // Nobody is signed in on the tab that started it: the server would refuse the credential with 401.
              if (Option.isSome(answered) && answered.value.output.signedOut === true) {
                yield* Metric.update(Metric.withAttributes(mints, { outcome: "signed_out", act: "none" }), 1)
                yield* Effect.logDebug("auth.run_credential").pipe(Effect.annotateLogs({ flow, outcome: "signed_out" }))
                return anonymousCredential
              }
            }
            const under = parent === null ? sessionCredential : yield* Cache.get(credentials, parent)
            // These compiled implementation flows are the person's Publish/Update, not a delegated agent.
            // Only the compiled operation chain inherits a session; a bearer parent never gains one.
            const implementation = parent !== null &&
              (flow === "branch/operation/start" || flow === "branch/operation/program") &&
              ["branch/publish", "branch/update", "branch/operation/start", "branch/operation/program"].includes((yield* runOf(parent)).flow)
            const resolved = ownPress || (implementation && under._tag === "Session")
              ? sessionCredential
              : under._tag === "Session"
              ? yield* mint(run, flow, undefined)
              : under._tag === "Token"
              ? yield* mint(run, flow, under.token)
              : under
            if (flow.startsWith("branch/")) yield* Effect.logInfo("branch.write.identity").pipe(Effect.annotateLogs({
              runId: run, flow, parentRunId: parent ?? "root", principal: resolved._tag, identity: ({ Session: "person", Token: "app", Anonymous: "refused", Refused: "refused" } as const)[resolved._tag],
            }))
            return resolved
          }).pipe(Effect.withSpan("auth.run_credential", { attributes: { "smithers.execution.id": run } })),
        {
          capacity: REMEMBERED,
          // The person's press is theirs for good; a lineage or a mint that failed is asked again.
          timeToLive: (exit) =>
            Exit.isFailure(exit)
              ? Duration.zero
              : exit.value._tag === "Session"
              ? Duration.infinity
              : exit.value._tag === "Anonymous"
              ? Duration.millis(ANONYMOUS_FOR_MS)
              : Duration.millis(CREDENTIAL_TTL_MS - RENEW_BEFORE_MS),
        },
      )

      /**
       * Asks ChatApi for run `run`'s credential, a run of `flow`: under the parent's credential `parent`, or in the
       * person's session. Each ask is a log line `auth.run_credential` and a count, with the flow and the outcome.
       */
      const mint = (run: string, flow: string, parent: string | undefined) =>
        Effect.gen(function* () {
          const ceiling = ceilings.get(flow) ?? []
          const request = HttpClientRequest.post(`${options.origin}${credentialRoute(run)}`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ flow, ...(ceiling.length === 0 ? {} : { ceiling }) }),
          )
          const principal = parent === undefined ? "session" : "credential"
          const response = yield* (parent === undefined ? base.execute(request) : asRun(request, parent)).pipe(
            // The ask never reached ChatApi: counted and logged like any other ask, by the transport's code.
            Effect.tapError((failure) =>
              Effect.andThen(
                Metric.update(Metric.withAttributes(mints, { outcome: "unreachable", act: "none" }), 1),
                Effect.logWarning("auth.run_credential").pipe(
                  Effect.annotateLogs({ flow, outcome: "unreachable", act: "none", principal, errorCode: codeOf(failure) }),
                ),
              )
            ),
            Effect.mapError(() => new CredentialUnavailable({ reason: "unreachable" })),
          )
          const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined))
          const credential: Credential | undefined = response.status === 200
            ? Option.match(decodeMinted(body), {
              onNone: () => undefined,
              onSome: ({ token, act }) => ({ _tag: "Token", token, act }) as const,
            })
            : response.status === 401
            ? { _tag: "Anonymous" }
            : response.status >= 400 && response.status < 500
            ? {
              _tag: "Refused",
              status: response.status,
              code: Option.match(decodeRefusal(body), { onNone: () => "refused", onSome: ({ code }) => code }),
            }
            : undefined
          const outcome = credential === undefined
            ? "unavailable"
            : credential._tag === "Token"
            ? "minted"
            : credential._tag === "Anonymous"
            ? "anonymous"
            : "refused"
          const act = credential?._tag === "Token" ? credential.act : "none"
          yield* Metric.update(Metric.withAttributes(mints, { outcome, act }), 1)
          yield* Effect.logWithLevel(outcome === "minted" ? "Debug" : "Warn")("auth.run_credential").pipe(
            Effect.annotateLogs({
              flow,
              outcome,
              act,
              principal,
              status: response.status,
              ...(credential?._tag === "Refused" ? { code: credential.code } : {}),
            }),
          )
          if (credential === undefined) return yield* new CredentialUnavailable({ reason: `status_${response.status}` })
          return credential
        })

      /** `request` as a run with credential `token`: the token, and no cookie. */
      const asRun = (request: HttpClientRequest.HttpClientRequest, token: string) =>
        withoutCookie(base.execute(withBearer(request, token)))

      const ownsApi = (url: string) => url.startsWith(`${options.origin}/api/`)

      /** How the current run's requests go; outside any run, as the host sends them: in the session. */
      const current = Effect.flatMap(
        Effect.serviceOption(FlowRuntime.FlowInstance),
        Option.match({
          onNone: () => Effect.succeed<Credential>({ _tag: "Session" }),
          onSome: (instance) => Cache.get(credentials, instance.executionId),
        }),
      )

      /** `request` sent as `credential` says. */
      const sendAs = (request: HttpClientRequest.HttpClientRequest, credential: Credential) => {
        if (credential._tag === "Session") return base.execute(request)
        if (credential._tag === "Token") return asRun(request, credential.token)
        if (credential._tag === "Anonymous") return withoutCookie(base.execute(request))
        // The server refused this run a credential: that refusal is the request's answer, and nothing is sent.
        return Effect.succeed(HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ code: credential.code }), {
            status: credential.status,
            headers: { "content-type": "application/json" },
          }),
        ))
      }

      const client: HttpClient.HttpClient = HttpClient.makeWith(
        (prepared: Effect.Effect<HttpClientRequest.HttpClientRequest>) =>
          Effect.flatMap(prepared, (request) =>
            Effect.gen(function* () {
              if (!ownsApi(request.url)) return yield* base.execute(request)
              const credential = yield* current.pipe(Effect.mapError(unavailable(request)))
              const response = yield* sendAs(request, credential)
              if (credential._tag !== "Token" || response.status !== 401) return response
              // The server no longer reads the credentials this engine holds, as when its key changed: they are asked
              // for again, once, and the request sent as the fresh one says.
              yield* Cache.invalidateAll(credentials)
              yield* Effect.logWarning("auth.run_credential").pipe(Effect.annotateLogs({ outcome: "stale" }))
              return yield* sendAs(request, yield* current.pipe(Effect.mapError(unavailable(request))))
            })),
        (request: HttpClientRequest.HttpClientRequest) => Effect.succeed(request),
      )

      return Context.make(HttpClient.HttpClient, client).pipe(
        Context.add(
          RunCredentials,
          RunCredentials.of({
            bearer: Effect.gen(function* () {
              const credential = yield* current
              if (credential._tag === "Session") return Option.none()
              if (credential._tag === "Token") return Option.some(credential.token)
              return yield* new CredentialUnavailable({
                reason: credential._tag === "Anonymous" ? "signed_out" : credential.code,
              })
            }),
          }),
        ),
      )
    }),
  )

/** A credential that couldn't be had, as the transport failure the request's step already handles. */
const unavailable = (request: HttpClientRequest.HttpClientRequest) => (error: CredentialUnavailable) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: `run credential ${error.reason}` }),
  })
