import { type Role, SIGN_IN } from "../auth/contract"
import {
  MCP_BLOCKED_ACTS,
  type McpClientId,
  type McpConsentDetails,
  type McpScope,
  type McpTokenSummary,
  mcpAgentLabel,
  mcpClientSnippet,
  mcpPermissionsFor,
  repoMcpUrl,
} from "./contract"
import { ACTING_AS, ALL_REPOSITORIES, consentHeading, SCOPE_LABEL, TOKEN_STATUS } from "./copy"

// What Bring Your Own Agent's views show, from the contract and the store's rows. Nothing here imports a library, so
// the web app and later the TUI share it.

/** The Connect agent dialog for one client on one repository. */
export interface ConnectDialogView {
  readonly snippet: { readonly label: string; readonly command: string; readonly note: string }
  /** The repository's MCP endpoint. */
  readonly endpoint: string
  /** Who the agent acts as: `<login> (agent)`, or the sign-in prompt for a signed-out visitor. */
  readonly actor: string
  readonly signedIn: boolean
  readonly roleLabel: string
  readonly allowed: ReadonlyArray<string>
  readonly blocked: ReadonlyArray<string>
  /** The acts no agent may take, whatever the role. */
  readonly blockedActs: ReadonlyArray<string>
}

/**
 * The dialog for `client` on `owner/name` at `origin`. `login` is the signed-in person's, `null` when signed out; a
 * signed-out visitor's agent has no role, whatever `role` says.
 */
export const connectDialogView = (
  client: McpClientId,
  origin: string,
  owner: string,
  name: string,
  role: Role | null,
  login: string | null,
): ConnectDialogView => {
  const signedIn = login !== null
  const permissions = mcpPermissionsFor(signedIn ? role : null)
  return {
    snippet: mcpClientSnippet(client, origin, owner, name),
    endpoint: repoMcpUrl(origin, owner, name),
    actor: signedIn ? mcpAgentLabel(login) : SIGN_IN,
    signedIn,
    roleLabel: permissions.roleLabel,
    allowed: permissions.allowed,
    blocked: permissions.blocked,
    blockedActs: MCP_BLOCKED_ACTS,
  }
}

/** A repository scope as people read it: `evmts/voltaire` from `github/evmts/voltaire`, or every repository. */
export const repoScopeLabel = (repoScope: string | null): string =>
  repoScope === null || repoScope === "" ? ALL_REPOSITORIES : repoScope.replace(/^github\//, "")

/** An ISO time as epoch milliseconds; `null` when there is none or it doesn't parse. */
const msOf = (iso: string | null): number | null => {
  if (iso === null) return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

export type TokenState = keyof typeof TOKEN_STATUS

/** One connected agent's row in Settings. */
export interface TokenRowView {
  readonly id: string
  readonly clientName: string
  readonly state: TokenState
  /** `Active`, `Revoked` or `Expired`. */
  readonly status: (typeof TOKEN_STATUS)[TokenState]
  readonly repoScope: string
  readonly scopes: ReadonlyArray<string>
  readonly createdAt: number | null
  readonly lastUsedAt: number | null
  readonly expiresAt: number | null
  /** Only an active token can be revoked. */
  readonly canRevoke: boolean
}

/** `token` as its Settings row shows it at `now`: revoked wins over expired. */
export const tokenRowView = (token: McpTokenSummary, now: number = Date.now()): TokenRowView => {
  const expiresAt = msOf(token.expiresAt)
  const state: TokenState = token.revokedAt !== null ? "revoked" : expiresAt !== null && expiresAt <= now ? "expired" : "active"
  return {
    id: token.id,
    clientName: token.clientName,
    state,
    status: TOKEN_STATUS[state],
    repoScope: repoScopeLabel(token.repoScope),
    scopes: scopeLabels(token.scopes),
    createdAt: msOf(token.createdAt),
    lastUsedAt: msOf(token.lastUsedAt),
    expiresAt,
    canRevoke: state === "active",
  }
}

/** The rows Settings lists: active first, then newest first. */
export const tokenRows = (tokens: ReadonlyArray<McpTokenSummary>, now: number = Date.now()): ReadonlyArray<TokenRowView> =>
  tokens
    .map((token) => tokenRowView(token, now))
    .sort((a, b) => Number(b.canRevoke) - Number(a.canRevoke) || (b.createdAt ?? 0) - (a.createdAt ?? 0))

/** Scopes as the screens say them, read before write, each once. */
export const scopeLabels = (scopes: ReadonlyArray<McpScope>): ReadonlyArray<string> =>
  (["mcp:read", "mcp:write"] as const).filter((scope) => scopes.includes(scope)).map((scope) => SCOPE_LABEL[scope])

/** The consent screen for one authorization request. */
export interface ConsentView {
  readonly heading: string
  readonly clientName: string
  /** `Acting as <login> (agent)`. */
  readonly actor: string
  readonly repoScope: string
  readonly scopes: ReadonlyArray<string>
  readonly roleLabel: string
  readonly allowed: ReadonlyArray<string>
  readonly blocked: ReadonlyArray<string>
  /** Where the browser goes after the decision: the callback's host, or its scheme for a native client. */
  readonly returnsTo: string
  /** One sentence saying all of it. */
  readonly summary: string
}

/** Where `redirectUri` leads, short enough to read: its host, or its scheme when it has none. */
const returnsToOf = (redirectUri: string): string => {
  try {
    const url = new URL(redirectUri)
    return url.host === "" ? url.protocol : url.host
    // expected: a callback that isn't a URL is shown as it was sent
  } catch {
    return redirectUri
  }
}

/** The consent screen for `details`: who asks, as whom, on what, and what the role allows and never allows. */
export const consentView = (details: McpConsentDetails): ConsentView => {
  const permissions = mcpPermissionsFor(details.effectiveRole, details.scopes)
  const repoScope = repoScopeLabel(details.repoScope)
  const scopes = scopeLabels(details.scopes)
  const actor = `${ACTING_AS} ${mcpAgentLabel(details.login)}`
  return {
    heading: consentHeading(details.clientName),
    clientName: details.clientName,
    actor,
    repoScope,
    scopes,
    roleLabel: permissions.roleLabel,
    allowed: permissions.allowed,
    blocked: permissions.blocked,
    returnsTo: returnsToOf(details.redirectUri),
    summary: `${details.clientName} · ${actor} · ${repoScope} · ${scopes.join(" + ")} · ${permissions.roleLabel}`,
  }
}

/**
 * `redirectTo` when it is the callback this request registered: the same scheme, host and path as `redirectUri`, and
 * never a script or data URL. Anything else is `undefined`, and the browser goes nowhere.
 */
export const verifiedRedirect = (redirectUri: string, redirectTo: string): string | undefined => {
  try {
    const registered = new URL(redirectUri)
    const target = new URL(redirectTo)
    if (["javascript:", "data:", "vbscript:", "blob:", "file:"].includes(target.protocol)) return undefined
    return target.protocol === registered.protocol && target.host === registered.host && target.pathname === registered.pathname
      ? target.toString()
      : undefined
    // expected: an address that isn't a URL is refused, as any other mismatch is
  } catch {
    return undefined
  }
}

/** A location's search as a route's query: `?a=b`, or nothing. */
export const searchOf = (search: string): string => (search === "" || search === "?" ? "" : search.startsWith("?") ? search : `?${search}`)
