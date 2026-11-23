import type { McpClientId, McpScope } from "./contract"

// Every word Bring Your Own Agent shows (docs: contract.ts): the Connect agent dialog on a repository, the Connected
// agents section of /app/settings and the OAuth consent screen at /app/mcp/authorize. Nothing here imports a library.

/** The repository header's button, and its dialog's title. */
export const CONNECT_AGENT = "Connect agent"

/** The dialog's title for repository `owner/name`. */
export const connectTitle = (owner: string, name: string) => `Connect your agent to ${owner}/${name}`

/** The client selector's accessible name. */
export const CLIENTS = "Agent client"

/** Each client preset's button. */
export const CLIENT_LABEL: Record<McpClientId, string> = {
  claude: "Claude Code",
  agy: "Antigravity (agy)",
  codex: "Codex",
  cursor: "Cursor",
  http: "Streamable HTTP",
  stdio: "CLI / Stdio",
}

/** The snippet's copy button. */
export const COPY_SNIPPET = "Copy connection snippet"

/** The permission card's title. */
export const AGENT_PERMISSIONS = "Agent Permissions"

/** Before who the agent acts as. */
export const ACTING_AS = "Acting as"

/** Before the person's role on the repository. */
export const YOUR_ROLE = "Your role"

/** What the agent may do. */
export const ALLOWED = "Allowed via MCP"

/** What no agent may do, whatever its person's role. */
export const BLOCKED = "Always Blocked (Person-Only)"

/** Under the blocked list: why. */
export const PERSON_ONLY_GUARD =
  "Your agent acts with your live GitHub role on this repository, checked on every call. Person-only actions need you, in the browser, whatever your role."

/** Shown in the dialog to a signed-out visitor. */
export const SIGNED_OUT_NOTE = "Signed out, an agent reads only what the public can. Sign in so it acts as you."

// Connected agents, on /app/settings.

/** The section's title. */
export const CONNECTED_AGENTS = "Connected agents"

/** Under the title. */
export const CONNECTED_AGENTS_ABOUT = "Agents you authorized over MCP. Each acts as you, never past your role, and stops at once when revoked."

export const REFRESH = "Refresh"
export const REVOKE = "Revoke"
export const REVOKING = "Revoking"
export const LOADING = "Loading"
export const NO_AGENTS = "No connected agents"
export const NO_AGENTS_ABOUT = "Open a repository and press Connect agent to add one."

/** A token's state. */
export const TOKEN_STATUS = { active: "Active", revoked: "Revoked", expired: "Expired" } as const

/** A token that works on every repository its person can reach. */
export const ALL_REPOSITORIES = "All repositories"

export const CREATED = "Created"
export const LAST_USED = "Last used"
export const NEVER_USED = "Never used"
export const EXPIRES = "Expires"

/** The revoke button's accessible name for `clientName`. */
export const revokeLabel = (clientName: string) => `Revoke ${clientName}`

// The consent screen, at /app/mcp/authorize.

/** The page's title. */
export const AUTHORIZE_AGENT = "Authorize agent"

/** The card's heading for `clientName`. */
export const consentHeading = (clientName: string) => `${clientName} wants to connect to Smithers`

/** A signed-out visitor's heading. */
export const SIGN_IN_TO_AUTHORIZE = "Sign in to authorize this agent"
export const SIGN_IN_TO_AUTHORIZE_ABOUT = "You return here after signing in with GitHub."

export const CLIENT = "Client"
export const REPOSITORY = "Repository"
export const ACCESS = "Access"
export const RETURNS_TO = "Returns to"
export const ROLE = "Live GitHub role"

/** Each scope, as the screen says it. */
export const SCOPE_LABEL: Record<McpScope, string> = { "mcp:read": "Read", "mcp:write": "Write" }

export const AUTHORIZE = "Authorize"
export const CANCEL = "Cancel"
export const REVIEW_REQUEST = "Review request"
export const REDIRECTING = "Returning to your agent"

/** How long an authorization lasts. */
export const tokenLifetime = (days: number) => `Access lasts ${days} days. Revoke it any time in Settings.`

/** Why a request failed, by its code. */
export const errorText = (code: string | null): string => {
  switch (code) {
    case null:
      return ""
    case "authentication":
      return "Sign in to continue."
    case "forbidden":
    case "person_only":
      return "Only you, signed in, can do this."
    case "token_limit":
      return "You have reached the limit of connected agents. Revoke one, then try again."
    case "invalid_request":
    case "invalid_client":
    case "invalid_scope":
    case "invalid_redirect_uri":
      return "This authorization request isn't valid. Start again from your agent."
    case "invalid_redirect":
      return "The return address didn't match this request, so nothing was sent."
    case "not_found":
      return "That agent is already gone."
    default:
      return "Smithers couldn't be reached. Try again."
  }
}
