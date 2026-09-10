/*
 * The issues cards: the list ("issue-list") and the detail ("issue"). Every
 * act binds a command through onRunCommand — the one delegated dispatch
 * CardView threads from App.tsx (parity.test.ts allowlists it). List rows open
 * the detail (issues.view); the detail carries the one state toggle
 * (issues.close / issues.reopen) and, on an unlinked issue, the door onto
 * issues.link-linear. Every interactive element carries data-flow with its
 * registered command name.
 */
import { Badge, Button, Markdown } from "@smthrs/ui"
import { MessageSquare } from "lucide-react"
import type { Card } from "../state/AppState"
import { trustedHttpsUrl } from "../state/seams/SeamContext"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

export interface IssueCardActions {
  readonly onRunCommand: RunCommand
}

/** Only an https linear.app URL off the DTO is followed; anything else renders the identifier as text. */
export const trustedLinearUrl = (value: string): string | null => trustedHttpsUrl(value, "linear.app")

const stateBadge = (state: "open" | "closed") => <Badge variant={state === "open" ? "success" : "muted"}>{state}</Badge>

/** "2026-08-11T09:00:00Z" → "2026-08-11 09:00"; a non-ISO string passes through. */
const dateLabel = (iso: string): string => iso.replace("T", " ").slice(0, 16)

export const IssueListCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "issue-list" }> } & IssueCardActions) => (
  <ul className="world-card-list">
    {card.payload.github !== undefined ?
      (
        <li className="world-card-path">
          {card.payload.github.refusal !== null
            ? `GitHub: ${card.payload.github.refusal}`
            : `GitHub · ${card.payload.github.source}${card.payload.github.syncedAt !== null ? ` · synced ${dateLabel(card.payload.github.syncedAt)}` : ""}${card.payload.github.stale ? " · stale" : ""}${card.payload.github.syncError !== null ? ` · sync error: ${card.payload.github.syncError}` : ""}`}
        </li>
      ) :
      null}
    {card.payload.issues.length === 0 ?
      (
        <li className="world-card-empty">
          {card.payload.filter === "all"
            ? `No issues in ${card.payload.repo}.`
            : `No ${card.payload.filter} issues in ${card.payload.repo}.`}
        </li>
      ) :
      (
        card.payload.issues.map((issue) => (
          <li key={issue.number} className="world-card-row">
            <Button
              variant="ghost"
              size="sm"
              data-flow="issues.view"
              onClick={() => onRunCommand("issues.view", `${issue.number} ${card.payload.repo}`)}
            >
              <span className="world-card-title">
                #{issue.number} {issue.title}
              </span>
            </Button>
            {stateBadge(issue.state)}
            {issue.source === "github" ? <span className="world-card-path">GitHub</span> : null}
            <span className="world-card-path">
              <MessageSquare size={12} aria-hidden="true" /> {issue.comments}
            </span>
            {issue.updatedAt !== null ? <span className="world-card-path">{dateLabel(issue.updatedAt)}</span> : null}
          </li>
        ))
      )}
  </ul>
)

export const IssueCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "issue" }> } & IssueCardActions) => {
  const { repo, number, title, state, author, issueBody, labels, comments, linear } = card.payload
  const toggleCommand = state === "open" ? "issues.close" : "issues.reopen"
  /* The DTO's URL is vetted like the install URL (review finding 10): https on linear.app, or no link at all. */
  const linearHref = linear != null ? trustedLinearUrl(linear.url) : null
  return (
    <div className="world-card-list">
      <div className="world-card-row">
        <span className="world-card-title">
          #{number} {title}
        </span>
        {stateBadge(state)}
      </div>
      <p className="world-card-path">
        {repo}
        {author !== null ? ` · opened by ${author}` : ""}
      </p>
      {/*
        * Lane sync (ADR 0005): the Linear link the DTO carries, or the act
        * that would set it. The act is a door ONTO the flow's form (THE FORM
        * LAW, superseding the ADR's composer prefill): it carries the issue
        * number it knows and issues.link-linear asks for the identifier.
        */}
      {linear != null ?
        (
          <p className="world-card-path">
            Linear{" "}
            {linearHref !== null ?
              <a href={linearHref} target="_blank" rel="noreferrer">{linear.identifier}</a> :
              <span>{linear.identifier}</span>}
          </p>
        ) :
        (
          <div className="world-card-row">
            <Button
              variant="ghost"
              size="sm"
              data-flow="issues.link-linear"
              onClick={() => onRunCommand("issues.link-linear", String(number))}
            >
              Link to Linear…
            </Button>
          </div>
        )}
      {labels.length > 0 ?
        (
          <div className="world-card-row">
            {labels.map((label) => (
              <Badge key={label} variant="outline">
                {label}
              </Badge>
            ))}
          </div>
        ) :
        null}
      {issueBody === "" ?
        <p className="world-card-empty">No description.</p> :
        <Markdown className="smithers-card-markdown" content={issueBody} />}
      {comments.length > 0 ?
        (
          <ul className="world-card-list">
            {comments.map((comment, index) => (
              <li key={`comment-${index}`}>
                <p className="world-card-path">
                  <MessageSquare size={12} aria-hidden="true" /> {comment.author ?? "unknown"}
                  {comment.createdAt !== null ? ` · ${dateLabel(comment.createdAt)}` : ""}
                </p>
                <Markdown className="smithers-card-markdown" content={comment.commentBody} />
              </li>
            ))}
          </ul>
        ) :
        null}
      <div className="world-card-row">
        <Button
          variant="outline"
          size="sm"
          data-flow={toggleCommand}
          onClick={() => onRunCommand(toggleCommand, `${number} ${repo}`)}
        >
          {state === "open" ? "Close issue" : "Reopen issue"}
        </Button>
      </div>
    </div>
  )
}

export const issueCardFamily: CardFamily<"issue-list" | "issue"> = {
  "issue-list": {
    render: (card, actions) => <IssueListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },
  issue: {
    render: (card, actions) => <IssueCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
