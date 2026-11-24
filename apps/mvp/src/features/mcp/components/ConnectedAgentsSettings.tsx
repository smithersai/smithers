import { Badge, Button, EmptyState, RelativeTime } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import {
  CONNECTED_AGENTS,
  CREATED,
  errorText,
  EXPIRES,
  LAST_USED,
  LOADING,
  NEVER_USED,
  NO_AGENTS,
  REFRESH,
  REVOKE,
  revokeLabel,
  REVOKING,
} from "../copy"
import { type TokenRowView, tokenRows } from "../view"
import { useMcpOptional } from "./McpContext"
import "./connect-agent.css"

// Connected agents on /app/settings: the MCP agents the signed-in person authorized, as ChatApi last listed them. Each
// row is its client, its repository or "All repositories", whether it is Active, Revoked or Expired, when it was
// created and last used, and Revoke, one press. Refresh asks again. The route's loader asks first
// (`mcp.actions.loadTokens()`); until something has, the section shows Refresh alone.

const TONE = { active: "success", revoked: "muted", expired: "warning" } as const

function Agent({ row, revoking, waiting, onRevoke }: { readonly row: TokenRowView; readonly revoking: boolean; readonly waiting: boolean; readonly onRevoke: (id: string) => Promise<void> }) {
  return (
    <li className="connected-agents-row" aria-label={`${row.clientName} ${row.repoScope}`}>
      <div className="connected-agents-row-what">
        <span className="connected-agents-row-name">
          {row.clientName}
          <Badge variant={TONE[row.state]}>{row.status}</Badge>
        </span>
        <span className="connected-agents-row-meta">
          <span>{row.repoScope}</span>
          <span>{row.scopes.join(" + ")}</span>
          {row.createdAt === null ? null : <span>{CREATED} <RelativeTime ts={row.createdAt} /></span>}
          <span>{row.lastUsedAt === null ? NEVER_USED : <>{LAST_USED} <RelativeTime ts={row.lastUsedAt} /></>}</span>
          {row.canRevoke && row.expiresAt !== null ? <span>{EXPIRES} <RelativeTime ts={row.expiresAt} /></span> : null}
        </span>
      </div>
      {row.canRevoke
        ? (
          <Button
            size="sm"
            variant="destructive"
            aria-label={revokeLabel(row.clientName)}
            disabled={waiting}
            onClick={() => void onRevoke(row.id)}
          >
            {revoking ? REVOKING : REVOKE}
          </Button>
        )
        : null}
    </li>
  )
}

export function ConnectedAgentsSettings() {
  const mcp = useMcpOptional()
  if (mcp === null) return null
  return <ConnectedAgentsSettingsInner mcp={mcp} />
}

function ConnectedAgentsSettingsInner({ mcp }: { readonly mcp: NonNullable<ReturnType<typeof useMcpOptional>> }) {
  const { queries, actions } = mcp
  const { data: state } = useLiveQuery(queries.tokens)
  const status = state?.status ?? "idle"
  const rows = tokenRows(state?.tokens ?? [])
  const waiting = status === "loading" || (state?.revokingId ?? null) !== null
  return (
    <section className="connected-agents" aria-label={CONNECTED_AGENTS}>
      <div className="connected-agents-head">
        <h2>{CONNECTED_AGENTS}</h2>
        <Button size="sm" variant="outline" disabled={waiting} onClick={() => void actions.loadTokens()}>{REFRESH}</Button>
      </div>
      <p role="status">{status === "loading" ? LOADING : errorText(state?.error ?? null)}</p>
      {status === "ready" && rows.length === 0 ? <EmptyState title={NO_AGENTS} /> : null}
      {rows.length === 0 ? null : (
        <ul className="connected-agents-list" aria-label={CONNECTED_AGENTS}>
          {rows.map((row) => <Agent key={row.id} row={row} revoking={state?.revokingId === row.id} waiting={waiting} onRevoke={actions.revokeToken} />)}
        </ul>
      )}
    </section>
  )
}
