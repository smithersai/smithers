import { Badge, Card, CardContent, CardHeader, CardTitle } from "@smthrs/ui"
import type { ReactNode } from "react"
import { AGENT_PERMISSIONS, ALLOWED, BLOCKED, YOUR_ROLE } from "../copy"
import "./connect-agent.css"

// What an agent may and may never do for one role (contract.ts `mcpPermissionsFor`): the card the Connect agent dialog
// and the consent screen both show, so the two never say different things. `who` is the line above the lists: who the
// agent acts as.
export function AgentPermissions(
  { roleLabel, allowed, blocked, who }: {
    readonly roleLabel: string
    readonly allowed: ReadonlyArray<string>
    readonly blocked: ReadonlyArray<string>
    readonly who?: ReactNode
  },
) {
  return (
    <Card aria-label={AGENT_PERMISSIONS}>
      <CardHeader>
        <CardTitle>{AGENT_PERMISSIONS}</CardTitle>
      </CardHeader>
      <CardContent className="connect-agent">
        <p className="connect-agent-who">
          {who}
          <span>{YOUR_ROLE}</span>
          <Badge variant="secondary">{roleLabel}</Badge>
        </p>
        <div className="connect-agent-permissions">
          <section aria-label={ALLOWED}>
            <h3>{ALLOWED}</h3>
            <ul>{allowed.map((line) => <li key={line}>{line}</li>)}</ul>
          </section>
          <section aria-label={BLOCKED}>
            <h3>{BLOCKED}</h3>
            <ul>{blocked.map((line) => <li key={line}>{line}</li>)}</ul>
          </section>
        </div>
      </CardContent>
    </Card>
  )
}
