import { Context, type Effect, type Option, Schema } from "effect"
import type { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Actor, Role } from "../Actor.ts"
import type { McpScope, McpTokenSummary } from "../../src/features/mcp/contract.ts"

// Shared backend contracts for worker/mcp/* so OAuth, Auth, Protocol, Tools, and Api build in parallel with zero drift.

/** A verified MCP agent principal derived from a non-revoked, non-expired `sma_` bearer token. */
export interface McpPrincipal {
  readonly tokenId: string
  readonly personId: string
  readonly login: string
  readonly clientName: string
  /** Canonical lowercase `github/<owner>/<name>` when token is pinned to one repository, else `null`. */
  readonly repoScope: string | null
  readonly scopes: ReadonlyArray<McpScope>
  /** Always carries `act: { kind: "agent", id: "mcp:<tokenId>" }` so every existing `person_only` guard enforces automatically. */
  readonly actor: Actor
}

/** Auth resolution outcome for an incoming MCP HTTP request. */
export type McpAuthResult =
  | { readonly _tag: "Anonymous" }
  | { readonly _tag: "Authenticated"; readonly principal: McpPrincipal }
  | {
      readonly _tag: "Rejected"
      readonly status: 401 | 403 | 503
      readonly code: "invalid_token" | "token_revoked" | "token_expired" | "repo_scope_mismatch" | "unavailable"
    }

/** Typed failure raised by MCP OAuth or token operations. */
export class McpAuthError extends Schema.TaggedError<McpAuthError>()("@smthrs/mvp/mcp/McpAuthError", {
  code: Schema.Literals([
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "invalid_redirect_uri",
    "invalid_scope",
    "authentication",
    "forbidden",
    "person_only",
    "token_limit",
    "not_found",
    "unavailable",
  ]),
  status: Schema.Number,
  detail: Schema.optional(Schema.String),
}) {}

/** Typed failure raised by MCP tool execution. */
export class McpToolError extends Schema.TaggedError<McpToolError>()("@smthrs/mvp/mcp/McpToolError", {
  code: Schema.Literals([
    "invalid_params",
    "authentication",
    "forbidden",
    "person_only",
    "not_found",
    "app_not_installed",
    "rate_limited",
    "conflict",
    "unavailable",
  ]),
  message: Schema.String,
}) {}

/** Live repository authorization result for an MCP tool invocation. */
export interface McpRepoAccess {
  readonly owner: string
  readonly name: string
  readonly repoId: string
  readonly role: Role | null
  readonly isPublic: boolean
}

/** OAuth + Token + Repo-Role security service implemented by `worker/mcp/Auth.ts` & `worker/mcp/OAuth.ts`. */
export class McpAuthService extends Context.Service<
  McpAuthService,
  {
    /** Resolves an optional `Authorization: Bearer sma_...` header to a verified `McpPrincipal`. */
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
      targetRepoId?: string,
    ) => Effect.Effect<McpAuthResult>
    /** Resolves live per-repo role + visibility for `principal` (or anonymous) on `owner/name` and enforces `repoScope`. */
    readonly resolveRepoAccess: (
      principal: Option.Option<McpPrincipal>,
      owner: string,
      name: string,
    ) => Effect.Effect<McpRepoAccess, McpToolError>
    /** Enforces minimum role + `mcp:write` scope + non-blocked act on a tool invocation. */
    readonly requireWriteAccess: (
      principal: Option.Option<McpPrincipal>,
      owner: string,
      name: string,
      minimum: Role,
    ) => Effect.Effect<{ readonly principal: McpPrincipal; readonly access: McpRepoAccess }, McpToolError>
    /** Lists the signed-in person's MCP tokens (person-only; rejects agent credentials). */
    readonly listTokens: (personId: string) => Effect.Effect<ReadonlyArray<McpTokenSummary>, McpAuthError>
    /** Revokes a single MCP token owned by `personId` (person-only). */
    readonly revokeToken: (personId: string, tokenId: string) => Effect.Effect<boolean, McpAuthError>
    /** Handles RFC 9728, RFC 8414, RFC 7591 DCR, OAuth authorize, token exchange, and `/api/me/mcp-tokens`. */
    readonly handleOAuthOrTokenRoute: (
      request: HttpServerRequest.HttpServerRequest,
      origin: string,
    ) => Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>>
  }
>()("@smthrs/mvp/mcp/McpAuthService") {}

/** JSON-RPC 2.0 request envelope accepted by Streamable HTTP MCP. */
export interface McpJsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly id?: string | number | null
  readonly method: string
  readonly params?: Record<string, unknown>
}

/** Standard MCP tool content block. */
export interface McpContentBlock {
  readonly type: "text"
  readonly text: string
}

/** MCP tool descriptor advertised in `tools/list`. */
export interface McpToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations?: {
    readonly readOnlyHint?: boolean
    readonly destructiveHint?: boolean
    readonly idempotentHint?: boolean
  }
}

/** Runtime context passed to every MCP tool handler. */
export interface McpToolContext {
  readonly principal: Option.Option<McpPrincipal>
  /** Default repository when called via `/<owner>/<name>/mcp` or `/api/repos/<owner>/<name>/mcp`. */
  readonly defaultRepo?: { readonly owner: string; readonly name: string }
  /** JSON-RPC request id for deterministic idempotency keys on writes. */
  readonly requestId: string
  readonly origin: string
}

/** Tool execution registry implemented by `worker/mcp/Tools.ts` and invoked by `worker/mcp/Protocol.ts`. */
export class McpToolRegistry extends Context.Service<
  McpToolRegistry,
  {
    readonly listTools: (
      principal: Option.Option<McpPrincipal>,
      defaultRepo?: { readonly owner: string; readonly name: string },
    ) => Effect.Effect<ReadonlyArray<McpToolDescriptor>>
    readonly callTool: (
      name: string,
      args: Record<string, unknown>,
      ctx: McpToolContext,
    ) => Effect.Effect<{ readonly content: ReadonlyArray<McpContentBlock>; readonly isError?: boolean }, McpToolError>
  }
>()("@smthrs/mvp/mcp/McpToolRegistry") {}
