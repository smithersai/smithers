import { Duration, Effect, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import {
  type CertificateState,
  type DnsRecord,
  routingRecord,
  type VerificationState,
} from "../../src/features/domains/contract.ts"
import {
  HostnameRejected,
  HostnameTaken,
  type Provider,
  ProviderUnavailable,
  type Registration,
} from "./Provider.vibe"

// Cloudflare for SaaS (decision 0039 §1): each domain is a custom hostname on the deployment's zone, whose certificate
// Cloudflare issues over HTTP validation once the domain's CNAME points at the zone's target. One request per call,
// never repeated here: a step's retry policy repeats the step. A token never reaches a record, a failure or a log.
//
// API: https://developers.cloudflare.com/api/resources/custom_hostnames/

/** Cloudflare's API origin. */
export const API_URL = "https://api.cloudflare.com/client/v4"

/** How long one request may take before the step counts Cloudflare unreachable. */
export const REQUEST_TIMEOUT = Duration.seconds(10)

/** What the adapter needs: the zone it adds hostnames to, its name, the CNAME target and an API token. */
export interface Options {
  readonly zoneId: string
  readonly zone: string
  readonly target: string
  readonly token: Redacted.Redacted<string>
  /** Another API origin, for the adapter's own tests. */
  readonly apiUrl?: string
}

/** The parts of a custom hostname this adapter reads. */
export interface CustomHostname {
  readonly id: string
  readonly hostname: string
  readonly status?: string
  readonly verification_errors?: ReadonlyArray<string>
  readonly ownership_verification?: { readonly type?: string; readonly name?: string; readonly value?: string }
  readonly ssl?: {
    readonly status?: string
    readonly validation_records?: ReadonlyArray<{ readonly txt_name?: string; readonly txt_value?: string }>
    readonly validation_errors?: ReadonlyArray<{ readonly message?: string }>
  }
}

const ACTIVE_HOSTNAME = new Set(["active", "active_redeploying", "provisioned", "test_active", "test_active_apex"])
const FAILED_HOSTNAME = new Set([
  "blocked",
  "pending_blocked",
  "moved",
  "deleted",
  "pending_deletion",
  "test_blocked",
  "test_failed",
])
const FAILED_CERTIFICATE = new Set([
  "expired",
  "deleted",
  "inactive",
  "deactivating",
  "initializing_timed_out",
  "validation_timed_out",
  "issuance_timed_out",
  "deployment_timed_out",
  "deletion_timed_out",
])

/** The hostname's `status` as verification. */
export const verificationOf = (status: string | undefined): VerificationState =>
  status !== undefined && ACTIVE_HOSTNAME.has(status)
    ? "active"
    : status !== undefined && FAILED_HOSTNAME.has(status)
    ? "failed"
    : "pending"

/** The certificate's `ssl.status` as its state. */
export const certificateOf = (status: string | undefined): CertificateState =>
  status === "active" ? "active" : status !== undefined && FAILED_CERTIFICATE.has(status) ? "failed" : "pending"

/** The longest problem kept: the provider's first reason, cut short. */
export const MAX_PROBLEM_LENGTH = 200

/**
 * A custom hostname as a registration: the routing record, then the ownership TXT while the hostname isn't active, then
 * each certificate validation TXT; the first reason Cloudflare gives for a stuck hostname or certificate as the problem.
 */
export const registrationOf = (custom: CustomHostname, target: string): Registration => {
  const verification = verificationOf(custom.status)
  const certificate = certificateOf(custom.ssl?.status)
  const records: Array<DnsRecord> = [routingRecord(custom.hostname, target)]
  const ownership = custom.ownership_verification
  if (verification !== "active" && ownership?.name !== undefined && ownership.value !== undefined) {
    records.push({ type: "TXT", name: ownership.name, value: ownership.value })
  }
  if (certificate !== "active") {
    for (const record of custom.ssl?.validation_records ?? []) {
      if (record.txt_name !== undefined && record.txt_value !== undefined) {
        records.push({ type: "TXT", name: record.txt_name, value: record.txt_value })
      }
    }
  }
  const reason = custom.status === "blocked" || custom.status === "pending_blocked"
    ? "blocked"
    : custom.status === "moved"
    ? "moved"
    : custom.verification_errors?.[0] ?? custom.ssl?.validation_errors?.find((error) => error.message)?.message
  return {
    id: custom.id,
    records,
    verification,
    certificate,
    ...(reason === undefined || verification === "active" && certificate === "active"
      ? {}
      : { problem: reason.slice(0, MAX_PROBLEM_LENGTH) }),
  }
}

interface Envelope {
  readonly success?: boolean
  readonly errors?: ReadonlyArray<{ readonly code?: number; readonly message?: string }>
  readonly result?: unknown
}

const parse = (text: string): Envelope => {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null ? parsed as Envelope : {}
  } catch {
    return {}
  }
}

/** The adapter over the `HttpClient` in context. */
export const make = (options: Options) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const base = `${options.apiUrl ?? API_URL}/zones/${encodeURIComponent(options.zoneId)}/custom_hostnames`

    /** One request: its status and body, or `ProviderUnavailable` when Cloudflare didn't answer in time. */
    const send = (request: HttpClientRequest.HttpClientRequest) =>
      http.execute(HttpClientRequest.bearerToken(request, Redacted.value(options.token))).pipe(
        Effect.flatMap((response) => Effect.map(response.text, (text) => ({ status: response.status, body: parse(text) }))),
        Effect.mapError(() => new ProviderUnavailable({ code: "unreachable" })),
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () => Effect.fail(new ProviderUnavailable({ code: "timeout" })),
        }),
      )

    /** A status Cloudflare didn't answer with success as `ProviderUnavailable`, named by status. */
    const unavailable = (status: number) => Effect.fail(new ProviderUnavailable({ code: `http_${status}` }))

    const find = (hostname: string) =>
      send(HttpClientRequest.get(base, { urlParams: { hostname } })).pipe(
        Effect.flatMap(({ status, body }) =>
          status === 200 && Array.isArray(body.result)
            ? Effect.succeed(
              Option.fromUndefinedOr((body.result as ReadonlyArray<CustomHostname>).find((custom) =>
                custom.hostname === hostname
              )),
            )
            : unavailable(status)
        ),
      )

    const create = (hostname: string) =>
      send(
        HttpClientRequest.post(base).pipe(
          HttpClientRequest.bodyJsonUnsafe({ hostname, ssl: { method: "http", type: "dv" } }),
        ),
      )

    const ensure: Provider["ensure"] = (hostname) =>
      Effect.gen(function* () {
        const found = yield* find(hostname)
        if (Option.isSome(found)) return registrationOf(found.value, options.target)
        const created = yield* create(hostname)
        if (created.status === 200 || created.status === 201) {
          return registrationOf(created.body.result as CustomHostname, options.target)
        }
        if (created.status === 429 || created.status >= 500) return yield* unavailable(created.status)
        // An earlier attempt may have created it and lost the answer: look again before calling it someone else's.
        const again = yield* find(hostname)
        if (Option.isSome(again)) return registrationOf(again.value, options.target)
        const message = created.body.errors?.[0]?.message ?? `http_${created.status}`
        if (created.status === 409 || /already|exists|duplicate/i.test(message)) return yield* new HostnameTaken()
        return yield* new HostnameRejected({ reason: message.slice(0, MAX_PROBLEM_LENGTH) })
      })

    const status: Provider["status"] = (id) =>
      send(HttpClientRequest.get(`${base}/${encodeURIComponent(id)}`)).pipe(
        Effect.flatMap(({ status, body }) =>
          status === 200
            ? Effect.succeed(Option.some(registrationOf(body.result as CustomHostname, options.target)))
            : status === 404
            ? Effect.succeed(Option.none())
            : unavailable(status)
        ),
      )

    const remove: Provider["remove"] = (id) =>
      send(HttpClientRequest.delete(`${base}/${encodeURIComponent(id)}`)).pipe(
        Effect.flatMap(({ status }) => status === 200 || status === 404 ? Effect.void : unavailable(status)),
      )

    return { name: "cloudflare", target: options.target, zone: options.zone, ensure, status, remove } satisfies Provider
  })
