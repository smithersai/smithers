/*
 * The PR (landing) cards: the list ("pr-list") and the detail ("pr"). A land
 * is QUEUED (202) — the card language says "queued", never a terminal claim.
 * Every act binds a registered command through onRunCommand and carries
 * data-flow (parity.test.ts gates this).
 */
import { Badge, Button, Markdown, RowButton, StatusPill } from "@smthrs/ui"
import { GitPullRequest, ListChecks, MessageSquare } from "lucide-react"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

export interface LandingCardActions {
  readonly onRunCommand: RunCommand
}

export const LandingListCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "pr-list" }> } & LandingCardActions) => (
  <ul className="world-card-list">
    {card.payload.landings.length === 0 ?
      <li className="world-card-empty">No pull requests in {card.payload.repo}.</li> :
      (
        card.payload.landings.map((landing) => (
          <li key={landing.number}>
            <RowButton
              data-flow="prs.view"
              aria-label={`Open pull request #${landing.number}`}
              onClick={() => onRunCommand("prs.view", `${landing.number} ${card.payload.repo}`)}
            >
              <span className="world-card-row">
                <GitPullRequest size={14} aria-hidden="true" />
                <span className="world-card-title">
                  #{landing.number} {landing.title}
                </span>
                {landing.author !== null ? <span className="world-card-path">by {landing.author}</span> : null}
                <StatusPill status={landing.state} />
              </span>
            </RowButton>
          </li>
        ))
      )}
  </ul>
)

export const LandingCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "pr" }> } & LandingCardActions) => (
  <div className="world-card-list">
    <p className="world-card-row">
      <span className="world-card-path">
        #{card.payload.number} · {card.payload.repo}
        {card.payload.author !== null ? ` · by ${card.payload.author}` : ""}
      </span>
      <StatusPill status={card.payload.state} />
    </p>
    {card.payload.prBody === "" ?
      <p className="world-card-empty">No description.</p> :
      <Markdown className="smithers-card-markdown" content={card.payload.prBody} />}
    <p className="world-card-path">
      <MessageSquare size={12} aria-hidden="true" /> Reviews
    </p>
    <ul className="world-card-list">
      {card.payload.reviews.length === 0 ? <li className="world-card-empty">No reviews yet.</li> : (
        card.payload.reviews.map((review, index) => (
          <li key={index} className="world-card-row">
            <Badge variant="outline">{review.type.replaceAll("_", " ")}</Badge>
            <span className="world-card-title">{review.author ?? "someone"}</span>
            {review.reviewBody !== "" ? <span className="world-card-path">{review.reviewBody}</span> : null}
          </li>
        ))
      )}
    </ul>
    <p className="world-card-path">
      <ListChecks size={12} aria-hidden="true" /> Checks
    </p>
    <ul className="world-card-list">
      {card.payload.checks.length === 0 ? <li className="world-card-empty">No checks reported.</li> : (
        card.payload.checks.map((check) => (
          <li key={check.context} className="world-card-row">
            <span className="world-card-title">{check.context}</span>
            <StatusPill status={check.state} />
          </li>
        ))
      )}
    </ul>
    <div className="world-card-row">
      <Button
        size="sm"
        data-flow="prs.land"
        onClick={() => onRunCommand("prs.land", `${card.payload.number} ${card.payload.repo}`)}
      >
        Land (queue merge)
      </Button>
      <Button
        size="sm"
        variant="outline"
        data-flow="prs.review"
        onClick={() => onRunCommand("prs.review", `${card.payload.number} approve ${card.payload.repo}`)}
      >
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        data-flow="prs.review"
        onClick={() => onRunCommand("prs.review", `${card.payload.number} request-changes ${card.payload.repo}`)}
      >
        Request changes
      </Button>
    </div>
  </div>
)

export const landingCardFamily: CardFamily<"pr-list" | "pr"> = {
  "pr-list": {
    render: (card, actions) => <LandingListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },
  pr: {
    render: (card, actions) => <LandingCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
