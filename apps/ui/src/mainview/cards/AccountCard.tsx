/*
 * The account card (factory mock 21, design session §6c): read-only seam
 * facts about the signed-in person, and the Sign out door. The GitHub login
 * and the allowlist answer always render (the identity seam holds both); the
 * scopes section renders only when the identity worker answered, and the
 * boxes section only when the workspaces seam has listed any. Nothing else
 * exists here: no billing, usage or seat rows, because no seam holds them.
 */
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

/** The allowlist answer in words: allowed, requested and waiting, or not yet allowed. */
export const accessLabel = (payload: { readonly allowlisted: boolean; readonly accessRequested: boolean }): string =>
  payload.allowlisted ? "Allowed" : payload.accessRequested ? "Requested, waiting on an answer" : "Not yet allowed"

export const AccountCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "account" }>
  readonly onRunCommand: RunCommand
}) => (
  <div className="world-card-list">
    <table className="secrets-table" aria-label="Account">
      <tbody>
        <tr data-testid="account-login">
          <th scope="row">GitHub</th>
          <td>Connected as @{card.payload.login}</td>
        </tr>
        <tr data-testid="account-access">
          <th scope="row">Access</th>
          <td>{accessLabel(card.payload)}</td>
        </tr>
      </tbody>
    </table>
    {card.payload.scopes.length === 0 ? null : (
      <>
        <p className="secrets-scope">GitHub scopes</p>
        <table className="secrets-table" aria-label="GitHub scopes">
          <tbody>
            {card.payload.scopes.map((row) => (
              <tr key={row.scope} data-testid={`account-scope-${row.scope}`}>
                <th scope="row">{row.scope}</th>
                <td>{row.plain}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    )}
    {card.payload.boxes.length === 0 ? null : (
      <>
        <p className="secrets-scope">Boxes</p>
        <table className="secrets-table" aria-label="Boxes">
          <tbody>
            {card.payload.boxes.map((box) => (
              <tr key={box.id} data-testid={`account-box-${box.id}`}>
                <th scope="row">{box.repoId}</th>
                <td>{box.name}</td>
                <td>{box.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    )}
    <Button size="sm" variant="outline" data-flow="auth.sign-out" onClick={() => onRunCommand("auth.sign-out")}>
      Sign out
    </Button>
  </div>
)

export const accountCardFamily: CardFamily<"account"> = {
  account: {
    render: (card, actions) => <AccountCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
