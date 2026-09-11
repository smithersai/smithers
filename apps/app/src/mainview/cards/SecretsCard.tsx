/*
 * The secrets card: the secrets a repository's sessions may use, as metadata
 * only. plue never serves a value, so the card has nothing to mask: one row per
 * secret with its name, the hosts its egress binding covers (or "setup only"
 * when it is delivered as a placeholder without a binding), the header the
 * proxy swaps it into, and the updated time. The header line states the scope
 * plainly because every session in the repository may use these; personal
 * secrets are a later lane's second scope.
 */
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"

/** The wire's ISO timestamp as a date, or the raw text when it does not parse. */
const updatedLabel = (updatedAt: string | null): string => {
  if (updatedAt === null) return ""
  const time = Date.parse(updatedAt)
  return Number.isNaN(time) ? updatedAt : new Date(time).toISOString().slice(0, 10)
}

export const SecretsCardBody = ({
  card
}: {
  readonly card: Extract<Card, { kind: "secrets" }>
}) => (
  <div className="world-card-list">
    <p className="world-card-path">{card.payload.repo}</p>
    <p className="secrets-scope" data-testid="secrets-scope">
      Repository secrets: every session in this repository may use them.
    </p>
    {card.payload.secrets.length === 0 ?
      <p className="world-card-empty">No secrets yet.</p> :
      (
        <table className="secrets-table" aria-label="Secrets">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Bound to</th>
              <th scope="col">Header</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {card.payload.secrets.map((secret) => (
              <tr key={secret.name} data-testid={`secret-${secret.name}`}>
                <td className="world-card-title">{secret.name}</td>
                <td>{secret.hosts.length === 0 ? "setup only" : secret.hosts.join(", ")}</td>
                <td>{secret.matchHeaders.join(", ")}</td>
                <td>{updatedLabel(secret.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
  </div>
)

export const secretsCardFamily: CardFamily<"secrets"> = {
  secrets: { render: (card) => <SecretsCardBody card={card} />, pill: settledPill }
}
