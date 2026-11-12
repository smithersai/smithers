/**
 * The RFC 6749 authorization-code request URL, with PKCE.
 *
 * @since 1.0.0
 */

import { isSecureEndpoint } from "./CredentialHttp.ts"

/**
 * One authorization request.
 *
 * @category models
 * @since 1.0.0
 */
export interface AuthorizationRequest {
  /** An absolute HTTPS URL (HTTP only on loopback). Its own query parameters survive. */
  readonly authorizationEndpoint: string
  readonly clientId: string
  readonly redirectUri: string
  /** The CSRF value echoed back on the redirect. */
  readonly state: string
  /** From `Pkce.createPkcePair`. */
  readonly codeChallenge: string
  /** A string, or scopes to space-join. Omitted when empty. */
  readonly scope?: string | ReadonlyArray<string> | undefined
  readonly codeChallengeMethod?: "S256" | "plain" | undefined
  /**
   * Provider-specific parameters, applied after the standard ones. The
   * security parameters are reserved: see {@link RESERVED_PARAMS}.
   */
  readonly extraParams?: Readonly<Record<string, string>> | undefined
}

/**
 * The query parameters `extraParams` may not replace.
 *
 * `state` is the CSRF binding and `code_challenge` with its method is the PKCE
 * binding, both validated above. Letting a caller overwrite them from a
 * provider-specific map would disable exactly the protections this builder
 * validates for, so they are refused rather than silently overwritten.
 * `response_type` stays overridable, which is the one case the parameter
 * exists for.
 *
 * @category constants
 * @since 1.0.0
 */
export const RESERVED_PARAMS: ReadonlyArray<string> = [
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method"
]

const parseEndpoint = (authorizationEndpoint: string): URL => {
  const invalid = () =>
    new TypeError("OAuth authorizationEndpoint must be an absolute HTTPS URL (HTTP is allowed only on loopback)")
  if (typeof authorizationEndpoint !== "string") throw invalid()
  let url: URL
  try {
    url = new URL(authorizationEndpoint)
  } catch {
    throw invalid()
  }
  if (!isSecureEndpoint(url)) throw invalid()
  return url
}

const requireNonEmpty = (name: string, value: string): void => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`OAuth ${name} must be a non-empty string`)
  }
}

const normalizeScope = (scope: string | ReadonlyArray<string> | undefined): string | undefined => {
  if (Array.isArray(scope)) {
    const joined = scope.join(" ")
    return joined.length > 0 ? joined : undefined
  }
  return typeof scope === "string" && scope.length > 0 ? scope : undefined
}

/**
 * Builds the URL to send the user to.
 *
 * `extraParams` is applied after the standard parameters, so a provider that
 * needs a different `response_type` can say so without a second builder. It
 * cannot replace a parameter in {@link RESERVED_PARAMS}: a `TypeError` naming
 * the key is raised instead.
 *
 * @category constructors
 * @since 1.0.0
 */
export const buildAuthorizationUrl = (request: AuthorizationRequest): string => {
  const url = parseEndpoint(request.authorizationEndpoint)
  requireNonEmpty("clientId", request.clientId)
  requireNonEmpty("redirectUri", request.redirectUri)
  requireNonEmpty("state", request.state)
  requireNonEmpty("codeChallenge", request.codeChallenge)

  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", request.clientId)
  url.searchParams.set("redirect_uri", request.redirectUri)
  url.searchParams.set("state", request.state)
  url.searchParams.set("code_challenge", request.codeChallenge)
  url.searchParams.set("code_challenge_method", request.codeChallengeMethod ?? "S256")

  const scope = normalizeScope(request.scope)
  if (scope !== undefined) url.searchParams.set("scope", scope)
  for (const [key, value] of Object.entries(request.extraParams ?? {})) {
    if (RESERVED_PARAMS.includes(key)) {
      throw new TypeError(`OAuth extraParams must not override the reserved parameter "${key}"`)
    }
    url.searchParams.set(key, value)
  }
  return url.toString()
}
