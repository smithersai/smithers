/*
 * The agent-environment card: vars and the setup script. Secrets are not this
 * card's: their metadata renders in the secrets card (/secrets.list), which the
 * footer names. Mutation goes through the typed /env.set command, not in-card
 * buttons.
 */
import { Terminal } from "lucide-react"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"

export const EnvCardBody = ({
  card
}: {
  readonly card: Extract<Card, { kind: "env" }>
}) => (
  <div className="world-card-list">
    <p className="world-card-path">{card.payload.repo}</p>
    {card.payload.vars.length === 0 ?
      <p className="world-card-empty">No environment variables yet — /env.set NAME=value adds one.</p> :
      (
        <ul className="world-card-list">
          {card.payload.vars.map((entry) => (
            <li key={entry.name} className="world-card-row">
              <span className="world-card-title">{entry.name}</span>
              <span className="world-card-path">{entry.value}</span>
            </li>
          ))}
        </ul>
      )}
    {card.payload.setupScript !== null ?
      (
        <div className="connect-store-row">
          <span className="connect-store-icon">
            <Terminal size={16} aria-hidden="true" />
          </span>
          <span className="connect-store-text">
            <strong>Setup script</strong>
          </span>
        </div>
      ) :
      null}
    {card.payload.setupScript !== null ? <pre className="world-card-path">{card.payload.setupScript}</pre> : null}
    <p className="world-card-path" data-testid="env-secrets-hint">
      Secrets have their own card: /secrets.list shows them.
    </p>
  </div>
)

export const envCardFamily: CardFamily<"env"> = {
  env: { render: (card) => <EnvCardBody card={card} />, pill: settledPill }
}
