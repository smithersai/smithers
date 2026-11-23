import type { Role } from "../auth/contract"

// Bring Your Own Agent (BYOA) via MCP contract between the browser, site Worker, and ChatApi.
// Zero runtime library imports so every side (browser, workerd, tests, docs) shares one source of truth.

/** Supported MCP protocol versions for Streamable HTTP transport. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number]

/** Global multi-repository Streamable HTTP MCP endpoint on ChatApi. */
export const MCP_ROUTE = "/api/mcp"

/** Repository-scoped Streamable HTTP MCP endpoint on ChatApi. */
export const repoMcpRoute = (owner: string, name: string): string =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/mcp`

/** Public repository-scoped MCP URL on the site Worker (forwarded to ChatApi). */
export const publicRepoMcpPath = (owner: string, name: string): string =>
  `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/mcp`

/** RFC 9728 OAuth Protected Resource Metadata endpoint. */
export const MCP_OAUTH_PROTECTED_RESOURCE_ROUTE = "/.well-known/oauth-protected-resource"

/** RFC 8414 OAuth Authorization Server Metadata endpoint. */
export const MCP_OAUTH_AUTH_SERVER_ROUTE = "/.well-known/oauth-authorization-server"

/** RFC 7591 Dynamic Client Registration endpoint (required by Claude Code / Codex MCP OAuth). */
export const MCP_OAUTH_REGISTER_ROUTE = "/api/mcp/oauth/register"

/** OAuth 2.1 authorization metadata & consent submission endpoint on ChatApi. */
export const MCP_OAUTH_AUTHORIZE_ROUTE = "/api/mcp/oauth/authorize"

/** OAuth 2.1 authorization code + PKCE S256 token exchange endpoint on ChatApi. */
export const MCP_OAUTH_TOKEN_ROUTE = "/api/mcp/oauth/token"

/** Person-only token management route: GET lists active tokens; DELETE <route>/<id> revokes one. */
export const MCP_TOKENS_ROUTE = "/api/me/mcp-tokens"

/** Browser OAuth consent screen path (TanStack Router). */
export const MCP_CONSENT_PATH = "/app/mcp/authorize"

/** Prefix for issued opaque MCP agent bearer tokens (`sma_<64 hex>`). */
export const MCP_TOKEN_PREFIX = "sma_"

/** Maximum byte size of a single MCP JSON-RPC or OAuth HTTP request body (256 KiB). */
export const MCP_MAX_REQUEST_BYTES = 256 * 1024

/** Default issued MCP token lifetime in days (30 days, revocable anytime). */
export const MCP_TOKEN_TTL_DAYS = 30

/** Maximum lifetime of a single-use OAuth authorization code in seconds (5 minutes). */
export const MCP_AUTH_CODE_TTL_SECONDS = 300

/** Maximum active non-revoked MCP tokens per person. */
export const MCP_MAX_ACTIVE_TOKENS_PER_PERSON = 32

/** Scopes an MCP token may carry. */
export const MCP_SCOPES = ["mcp:read", "mcp:write"] as const
export type McpScope = (typeof MCP_SCOPES)[number]

/** Supported MCP client presets shown in the Connect Agent UI. */
export const MCP_CLIENTS = ["claude", "codex", "agy", "cursor", "http", "stdio"] as const
export type McpClientId = (typeof MCP_CLIENTS)[number]

/** Actions that are strictly person-only and NEVER exposed via MCP, even for an Admin/Maintainer's own agent. */
export const MCP_BLOCKED_ACTS = [
  "pull/merge",
  "issue/triage",
  "issue/commitment",
  "triage/enable",
  "triage/pause",
  "todo/commit",
  "todo/drop",
  "secrets/write",
  "runner/register",
  "model/write",
] as const

export type McpBlockedAct = (typeof MCP_BLOCKED_ACTS)[number]

/** Summary row of a connected MCP agent token returned to Settings (never carries the raw token or hash). */
export interface McpTokenSummary {
  readonly id: string
  readonly clientName: string
  readonly repoScope: string | null
  readonly scopes: ReadonlyArray<McpScope>
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastUsedAt: string | null
  readonly revokedAt: string | null
}

/** OAuth authorization request metadata rendered by the browser consent screen. */
export interface McpConsentDetails {
  readonly clientId: string
  readonly clientName: string
  readonly redirectUri: string
  readonly repoScope: string | null
  readonly scopes: ReadonlyArray<McpScope>
  readonly state: string | null
  readonly codeChallenge: string
  readonly codeChallengeMethod: "S256"
  readonly login: string
  readonly effectiveRole: Role | null
}

/** Attribution label for an agent acting on behalf of `login` via MCP (matches decision 0028). */
export const mcpAgentLabel = (login: string): string => `${login} (agent)`

/** Canonical full URL for a repository-scoped MCP endpoint. */
export const repoMcpUrl = (origin: string, owner: string, name: string): string =>
  `${origin.replace(/\/+$/, "")}${publicRepoMcpPath(owner, name)}`

/** Canonical server slug for CLI snippets (safe alphanumeric/dash identifier). */
export const mcpServerSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "smithers"

/** Copy-pasteable connection snippet for each supported MCP client. */
export const mcpClientSnippet = (
  client: McpClientId,
  origin: string,
  owner: string,
  name: string,
): { readonly label: string; readonly command: string; readonly note: string } => {
  const slug = mcpServerSlug(name)
  const url = repoMcpUrl(origin, owner, name)
  const cleanOrigin = origin.replace(/\/+$/, "")
  switch (client) {
    case "claude":
      return {
        label: "Run once in your terminal",
        command: `claude mcp add ${slug} --transport http ${url}`,
        note: "Claude Code discovers OAuth automatically and opens your browser to authorize once. No API keys leave your machine.",
      }
    case "codex":
      return {
        label: "Run once in your terminal",
        command: `codex mcp add ${slug} --url ${url}`,
        note: "Codex discovers OAuth 2.1 metadata automatically and stores the scoped token locally.",
      }
    case "agy":
      return {
        label: "Run once in your terminal (Google Gemini models only)",
        command: `agy mcp add ${slug} --transport http ${url}`,
        note: "Antigravity CLI connects over Streamable HTTP MCP with OAuth 2.1. Use Google Gemini models (gemini-*) only.",
      }
    case "cursor":
      return {
        label: "Add to .cursor/mcp.json",
        command: JSON.stringify({ mcpServers: { [slug]: { url } } }, null, 2),
        note: "Cursor signs in with your GitHub session on Smithers and scopes the connection to this repository.",
      }
    case "http":
      return {
        label: "Streamable HTTP MCP 2025-11-25",
        command: `Endpoint:  ${url}\nDiscovery: ${cleanOrigin}${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/mcp\nAuth:      OAuth 2.1 + PKCE (S256) + Dynamic Client Registration`,
        note: `Multi-repository endpoint is also available at ${cleanOrigin}${MCP_ROUTE}.`,
      }
    case "stdio":
      return {
        label: "Fallback for stdio-only clients",
        command: `npx @smthrs/cli mcp login --origin ${cleanOrigin}\nnpx @smthrs/cli mcp serve --repo ${owner}/${name}`,
        note: "Uses OAuth 2.1 + PKCE and bridges stdio MCP to Smithers with the same role and person-only guards.",
      }
  }
}

/** Human-readable allowed and blocked capabilities disclosed in Connect Agent & OAuth Consent UIs. */
export const mcpPermissionsFor = (
  role: Role | null,
): {
  readonly roleLabel: string
  readonly allowed: ReadonlyArray<string>
  readonly blocked: ReadonlyArray<string>
} => {
  if (role === "admin" || role === "maintainer") {
    return {
      roleLabel: role === "admin" ? "Admin" : "Maintainer",
      allowed: [
        "Read repository files, refs, issues, pull requests, and workflows",
        "Run bug validation (issue/repro), PoC, and review flows locally",
        "Open issues and post comments attributed as your agent",
        "Draft TODOs on the stack and post live work links",
      ],
      blocked: [
        "Merge pull requests or approve human gates (person-only)",
        "Override final issue triage or commitments (person-only)",
        "Commit TODOs, edit repository secrets, or read API keys",
      ],
    }
  }
  if (role === "member") {
    return {
      roleLabel: "Member",
      allowed: [
        "Read repository files, refs, issues, pull requests, and workflows",
        "Open issues and post comments attributed as your agent",
        "Draft TODOs on the stack",
      ],
      blocked: [
        "Merge pull requests or override triage (person-only)",
        "Commit TODOs, manage secrets, or access admin settings",
      ],
    }
  }
  return {
    roleLabel: role === "guest" ? "Contributor (Guest)" : "Public Visitor",
    allowed: [
      "Read public repository files, docs, issues, pull requests, and public flows",
      "Fetch bug-validation workflows (issue/repro) to run on your own machine",
      ...(role === "guest" ? ["Open issues and comment attributed as your agent"] : []),
    ],
    blocked: [
      "Triage issues, apply smithers:* labels, or access the TODO stack",
      "View maintainer feeds, secrets, or run server-side sandboxes",
      "Approve or merge pull requests",
    ],
  }
}

/** Matches a public repository-scoped MCP pathname `/<owner>/<repo>/mcp`. */
export const parsePublicRepoMcpPath = (
  pathname: string,
): { readonly owner: string; readonly name: string } | null => {
  const parts = pathname.split("/")
  if (parts.length !== 4 || parts[0] !== "" || parts[3] !== "mcp") return null
  const [, owner, name] = parts
  if (owner === undefined || name === undefined || owner === "" || name === "") return null
  if (owner === "api" || owner === "app" || owner === "assets" || owner === ".well-known") return null
  return { owner, name }
}
