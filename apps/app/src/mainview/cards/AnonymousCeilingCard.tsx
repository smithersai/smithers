/*
 * The anonymous turn ceiling's refusal card (factory mock 22). A signed-out
 * visitor's turn the Worker refused with 429 turn_rate_limited renders here
 * instead of the generic failure line: the server's own sentence, when the
 * ceiling resets, and sign-in as the primary door, because signed-in turns
 * are never subject to the anonymous ceiling. Nothing is invented: the
 * sentence and the reset time are the body's, and a body with no reset time
 * says only what the ceiling's window is.
 */
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"

type AnonymousCeilingCard = Extract<Card, { kind: "anonymous-ceiling" }>

/** The ceiling's window is one day (apps/server turnLimit.ts ANONYMOUS_TURN_WINDOW_MS). */
export const RESETS_DAILY = "Resets daily"

const pad = (value: number): string => String(value).padStart(2, "0")

/**
 * The reset line. The Worker names the reset as an ISO instant; it renders in
 * UTC so the line reads the same everywhere and never guesses a time zone.
 */
export const resetLine = (retryAt: string | null): string => {
  if (retryAt === null) return RESETS_DAILY
  const at = new Date(retryAt)
  if (Number.isNaN(at.getTime())) return RESETS_DAILY
  return `Resets at ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
}

export const AnonymousCeilingCardBody = ({
  card,
  onConnectGitHub
}: {
  readonly card: AnonymousCeilingCard
  readonly onConnectGitHub: () => void
}) => (
  <div className="anonymous-ceiling" data-testid="anonymous-ceiling">
    <p data-testid="anonymous-ceiling-message">{card.payload.message}</p>
    <p className="smithers-card-note" data-testid="anonymous-ceiling-reset">{resetLine(card.payload.retryAt)}</p>
    <div className="flow-run-actions">
      <Button size="sm" data-flow="auth.sign-in" onClick={() => onConnectGitHub()}>
        Sign in with GitHub
      </Button>
    </div>
  </div>
)

export const anonymousCeilingCardFamily: CardFamily<"anonymous-ceiling"> = {
  "anonymous-ceiling": {
    render: (card, actions) => <AnonymousCeilingCardBody card={card} onConnectGitHub={actions.onConnectGitHub} />,
    /* A refusal is a pause, not a failure: the turn was never sent. */
    pill: () => "paused"
  }
}
