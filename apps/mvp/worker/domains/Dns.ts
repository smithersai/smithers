import { Duration, Effect, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { routingRecord } from "../../src/features/domains/contract.ts"
import { type Provider, ProviderUnavailable, type Registration } from "#vibelang/source/worker/domains/Provider"

// The provider for a host that terminates its own TLS (decision 0039 §3): development, the end-to-end tests, and a
// self-hosted or native deployment. It registers nothing anywhere. A domain is verified once public DNS gives it the
// target as its CNAME. Shared addresses prove nothing (a CDN serves many owners), so an apex its DNS provider flattens
// stays pending here. It asks a DNS-over-HTTPS resolver (RFC 8484's JSON form), so the answer is the public one, never
// this machine's resolver or hosts file. The host, not this provider, has the certificate: `unmanaged`.

/** The resolver asked when `DOMAINS_DOH_URL` names none. */
export const DOH_URL = "https://cloudflare-dns.com/dns-query"

/** How long one lookup may take before the check counts the resolver unreachable. */
export const LOOKUP_TIMEOUT = Duration.seconds(5)

/** What the adapter needs: the deployment's zone, the CNAME target and, optionally, another resolver. */
export interface Options {
  readonly zone: string
  readonly target: string
  readonly dohUrl?: string
}

/** A DNS-over-HTTPS JSON answer's parts this adapter reads. */
interface Answer {
  readonly Status?: number
  readonly Answer?: ReadonlyArray<{ readonly type?: number; readonly data?: string }>
}

/** The CNAME RR type. */
const CNAME = 5

/** A name as DNS answers it, without the trailing dot, lowercased. */
const bare = (name: string) => name.toLowerCase().replace(/\.$/, "")

/** Whether `answer`, a CNAME lookup, gives `target` as the name's CNAME. */
export const pointsAt = (target: string, answer: Answer): boolean =>
  (answer.Answer ?? []).some((record) => record.type === CNAME && bare(record.data ?? "") === bare(target))

/** The adapter over the `HttpClient` in context. */
export const make = (options: Options) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const resolver = options.dohUrl ?? DOH_URL
    const target = bare(options.target)

    const lookup = (name: string): Effect.Effect<Answer, ProviderUnavailable> =>
      http.execute(
        HttpClientRequest.get(resolver, { urlParams: { name, type: "CNAME" }, headers: { accept: "application/dns-json" } }),
      ).pipe(
        Effect.mapError(() => new ProviderUnavailable({ code: "unreachable" })),
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.mapError(response.text, () => new ProviderUnavailable({ code: "unreachable" }))
            : Effect.fail(new ProviderUnavailable({ code: `doh_${response.status}` }))
        ),
        Effect.flatMap((text) =>
          Effect.try({
            try: () => JSON.parse(text) as Answer,
            catch: () => new ProviderUnavailable({ code: "malformed" }),
          })
        ),
        Effect.timeoutOrElse({
          duration: LOOKUP_TIMEOUT,
          orElse: () => Effect.fail(new ProviderUnavailable({ code: "timeout" })),
        }),
      )

    const check = (hostname: string) =>
      Effect.gen(function* () {
        const verified = pointsAt(target, yield* lookup(hostname))
        return {
          id: hostname,
          records: [routingRecord(hostname, target)],
          verification: verified ? "active" : "pending",
          certificate: "unmanaged",
        } satisfies Registration
      })

    return {
      name: "dns",
      target,
      zone: bare(options.zone),
      ensure: check,
      status: (_id, hostname) => Effect.map(check(hostname), Option.some),
      remove: () => Effect.void,
    } satisfies Provider
  })
