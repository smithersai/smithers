// Custom domains' contract between the browser, ChatApi, the flows and the tests (decision 0039,
// docs/features/domains.md). Nothing here imports a library, so every side can.

/** Where a repository's domains are written: `POST <repo>/domains { hostname }`, `DELETE <repo>/domains/<hostname>`. */
export const DOMAINS_SEGMENT = "domains"

/** ChatApi's Electric shape proxy for one repository's domains: `GET ?repo=<repo id>`, Maintainers and Admins only. */
export const DOMAINS_SHAPE_ROUTE = "/api/shapes/domains"

/** The Postgres table of domains (db/migrations/0046_domains.ts). */
export const DOMAINS_TABLE = "domains"

/** The columns a device syncs: everything but the provider's id, the poll and who changed it. */
export const DOMAINS_SHAPE_COLUMNS = [
  "hostname",
  "repo_id",
  "state",
  "verification",
  "certificate",
  "records",
  "problem",
  "checked_at",
  "updated_at",
] as const

/** The largest `POST` body, in bytes: `{ "hostname": … }` with a 253-character hostname fits many times over. */
export const MAX_DOMAIN_BODY_BYTES = 1_024

/** The longest hostname DNS carries, without its trailing dot (RFC 1035 §2.3.4). */
export const MAX_HOSTNAME_LENGTH = 253

/** A domain's state: waiting for DNS, serving, given up on, or being removed. */
export const DOMAIN_STATES = ["pending", "active", "failed", "removing"] as const
export type DomainState = (typeof DOMAIN_STATES)[number]

/** Ownership verification's state at the provider. */
export const VERIFICATION_STATES = ["pending", "active", "failed"] as const
export type VerificationState = (typeof VERIFICATION_STATES)[number]

/** The certificate's state: `unmanaged` when the host, not the provider, terminates TLS. */
export const CERTIFICATE_STATES = ["pending", "active", "failed", "unmanaged"] as const
export type CertificateState = (typeof CERTIFICATE_STATES)[number]

/** One DNS record the maintainer adds at their DNS provider. */
export interface DnsRecord {
  readonly type: "CNAME" | "ALIAS" | "TXT"
  readonly name: string
  readonly value: string
}

/** The path of a repository's domains: `/api/repos/<owner>/<name>/domains`. */
export const domainsRoute = (owner: string, name: string): string =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${DOMAINS_SEGMENT}`

/** The path of one domain: `/api/repos/<owner>/<name>/domains/<hostname>`. */
export const domainRoute = (owner: string, name: string, hostname: string): string =>
  `${domainsRoute(owner, name)}/${encodeURIComponent(hostname)}`

/** A route's owner and repository, and the hostname when the path is one domain's. */
export const parseDomainRoute = (
  path: string,
): { readonly owner: string; readonly name: string; readonly hostname?: string } | undefined => {
  const match = /^\/api\/repos\/([^/]+)\/([^/]+)\/domains(?:\/([^/]+))?$/.exec(path)
  if (match === null) return undefined
  try {
    const owner = decodeURIComponent(match[1]!)
    const name = decodeURIComponent(match[2]!)
    return match[3] === undefined ? { owner, name } : { owner, name, hostname: decodeURIComponent(match[3]) }
    // expected: a path that does not decode names no domain
  } catch {
    return undefined
  }
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/**
 * `raw` as a hostname a domain can be: trimmed, lowercased, without a trailing dot; two or more labels of letters,
 * digits and inner hyphens, at most 253 characters, and a top-level label that isn't all digits (so never an IPv4
 * address). No scheme, path, port or wildcard; a name outside ASCII comes in its `xn--` form. `undefined` otherwise.
 */
export const normalizeHostname = (raw: string): string | undefined => {
  const hostname = raw.trim().toLowerCase().replace(/\.$/, "")
  if (hostname.length === 0 || hostname.length > MAX_HOSTNAME_LENGTH) return undefined
  const labels = hostname.split(".")
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined
  return /^[0-9]+$/.test(labels.at(-1)!) ? undefined : hostname
}

/**
 * Whether `hostname` is a zone's apex, which can't hold a CNAME: two labels, such as `vibelang.sh`. A name under a
 * two-label public suffix, such as `example.co.uk`, counts as a subdomain; its DNS provider says so when it refuses the
 * CNAME.
 */
export const isApex = (hostname: string): boolean => hostname.split(".").length === 2

/** Whether `hostname` is `zone` or under it: the deployment's own names can't be a custom domain. */
export const isUnder = (hostname: string, zone: string): boolean => hostname === zone || hostname.endsWith(`.${zone}`)

/** The record that points `hostname` at `target`: a CNAME, or an ALIAS (CNAME flattening) at an apex. */
export const routingRecord = (hostname: string, target: string): DnsRecord => ({
  type: isApex(hostname) ? "ALIAS" : "CNAME",
  name: hostname,
  value: target,
})

/** The execution id of one write: `domain-add:<id>` or `domain-remove:<id>`, the request's own id. */
export const writeExecutionId = (op: "add" | "remove", id: string): string => `domain-${op}:${id}`

/** Why a write was refused: what the browser shows, one code per answer. */
export const REFUSALS = [
  "authentication",
  "forbidden",
  "person_only",
  "not_found",
  "invalid",
  "invalid_hostname",
  "reserved",
  "taken",
  "too_large",
  "off",
  "unavailable",
] as const
export type Refusal = (typeof REFUSALS)[number]

/**
 * What custom domains record in the browser, by name, and the attributes they carry (docs/observability.md#custom-domains):
 * each press, each write a step sent, and its request. None carries a hostname or a DNS record. src/telemetry.ts merges
 * them into what ChatApi's relay keeps.
 */
export const DOMAINS_TELEMETRY = {
  records: [
    "domain.add.press",
    "domain.refresh.press",
    "domain.remove.press",
    "domain.request",
    "domain.add.send",
    "domain.remove.send",
    "domain.copy",
    "smithers_web_domain_requests",
  ],
  fields: ["op", "outcome", "status", "code", "feature", "errorCode"],
} as const
