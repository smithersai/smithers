// Repository secrets' contract between the browser, ChatApi, the flows and the tests (decision 0005 §4,
// docs/features/secrets.md). Nothing here imports a library, so every side can.

/** Where a repository's secrets are written: `PUT` and `DELETE <route>/<owner>/<name>/secrets/<NAME>`. */
export const SECRETS_SEGMENT = "secrets"

/** `PUT` body: `{ value, hosts, methods? }`. Its value is at most 16 KiB, so 32 KiB holds any valid body. */
export const MAX_PUT_BODY_BYTES = 32 * 1024

/** ChatApi's Electric shape proxy for one repository's secrets, names and bindings only: `GET ?repo=<repo id>`. */
export const SECRETS_SHAPE_ROUTE = "/api/shapes/secrets"

/** The Postgres table of secrets (db/migrations/0021_secrets.ts). */
export const SECRETS_TABLE = "secrets"

/** The only columns the shape sends: never `ciphertext`, `nonce` or `key_version`. */
export const SECRETS_SHAPE_COLUMNS = ["repo_id", "name", "hosts", "methods", "updated_at"] as const

/** The path of one secret: `/api/repos/<owner>/<name>/secrets/<NAME>`. */
export const secretRoute = (owner: string, name: string, secret: string): string =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${SECRETS_SEGMENT}/${encodeURIComponent(secret)}`

/** A route's owner, repository and secret name, when the path is a secret's. */
export const parseSecretRoute = (
  path: string,
): { readonly owner: string; readonly name: string; readonly secret: string } | undefined => {
  const match = /^\/api\/repos\/([^/]+)\/([^/]+)\/secrets\/([^/]+)$/.exec(path)
  if (match === null) return undefined
  try {
    return { owner: decodeURIComponent(match[1]!), name: decodeURIComponent(match[2]!), secret: decodeURIComponent(match[3]!) }
    // expected: a malformed route names no secret
  } catch {
    return undefined
  }
}

/** The execution id of one write: `secret-put:<id>` or `secret-delete:<id>`, the request's own id. */
export const writeExecutionId = (op: "put" | "delete", id: string): string => `secret-${op}:${id}`

/** Why a write was refused: what the browser shows, one code per answer. */
export const REFUSALS = [
  "authentication",
  "forbidden",
  "not_found",
  "invalid",
  "invalid_name",
  "invalid_hosts",
  "too_short",
  "too_long",
  "control_character",
  "malformed_text",
  "too_large",
  "off",
  "unavailable",
] as const
export type Refusal = (typeof REFUSALS)[number]

/** Why the browser's write was refused: one of the server's refusals, or `exists` for an Add of a name the list has. */
export type WriteFailure = Refusal | "exists"

/** The hosts a person typed: split on commas, spaces and line breaks, blanks dropped. The server checks each one. */
export const splitHosts = (text: string): ReadonlyArray<string> => text.split(/[\s,]+/).filter((host) => host !== "")

/** The browser's records of secret writes (src/telemetry.ts): names, hosts, outcomes and codes; never a value. */
export const SECRETS_TELEMETRY = {
  records: ["secrets.put", "secrets.delete", "secrets.write", "smithers_web_secret_writes"],
  fields: ["op", "outcome", "code", "hosts"],
} as const
