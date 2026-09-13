/*
 * The repository update card: a GitHub-shaped digest of what changed since
 * the last check. Header counts, one row per changed issue / PR /
 * notification (unread rows carry a dot and open their detail card), and a
 * footer with the two update actions. Built on the same ghc-* system as the
 * issue and PR lists so the tutorial reads as one product.
 */
import { Button } from "@smthrs/ui"
import { AlertTriangle, RefreshCw } from "lucide-react"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { issueDisplay, LabelPill, prDisplay, repoLabel, StateIcon } from "./GithubParts"
import { Octicon } from "./Octicon"

type UpdateItem = Extract<Card, { kind: "repo-update" }>["payload"]["items"][number]

const KIND_LABEL: Readonly<Record<UpdateItem["kind"], string>> = { issue: "Issue", pr: "Pull request", notification: "Notification" }

/** Tags are `[kind, state, ...labels]` (RepositoryUpdateSource); only the labels are pills. */
const labelsOf = (item: UpdateItem): ReadonlyArray<string> =>
  item.tags.filter(tag => tag !== item.kind && tag !== item.state && tag !== "notification")

const displayOf = (item: UpdateItem) =>
  item.kind === "pr" ? prDisplay(item.state) : issueDisplay(item.state === "closed" ? "closed" : "open")

const timeLabel = (at: number | string): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

export const repositoryUpdateCardFamily: CardFamily<"repo-update"> = {
  "repo-update": {
    pill: settledPill,
    render: (card, actions) => {
      const { repo, items, problems, openIssues, openPrs, branch, checkedAt, summary } = card.payload
      const unread = items.filter(item => !item.read).length
      return <div className="ghc ghc-box repo-update" aria-label="Smithers repository update">
        <div className="ghc-toolbar repo-update-toolbar">
          <span className="ghc-count" data-active="true"><Octicon name="issue-opened" /> {openIssues ?? "–"} Open issues</span>
          <span className="ghc-count" data-active="true"><Octicon name="git-pull-request" /> {openPrs ?? "–"} Open PRs</span>
          {branch && <span className="ghc-branch"><Octicon name="git-branch" /> {branch}</span>}
          <span className="ghc-toolbar-repo">{repoLabel(repo)}</span>
        </div>
        <p className="ghc-note repo-update-summary">
          <span>{summary}</span>
          <span className="repo-update-checked">Checked {timeLabel(checkedAt)}</span>
        </p>
        {problems.length > 0 && <p className="ghc-note repo-update-problem" role="status">
          <AlertTriangle size={14} aria-hidden="true" /> Partial update: {problems.join(" ")} Counts cover the activity received.
        </p>}
        {items.length === 0 ?
          <p className="ghc-empty"><Octicon name="check" size={24} /><span>Nothing new since the last check.</span></p> :
          <ul className="ghc-rows repo-update-items">
            {items.map(item => {
              const display = displayOf(item)
              const viewFlow = item.kind === "pr" ? "prs.view" : item.kind === "issue" ? "issues.view" : undefined
              const meta = <span className="ghc-row-meta">
                {item.number ? `#${item.number} · ` : ""}{KIND_LABEL[item.kind]} · {item.state}
              </span>
              const body = <>
                <StateIcon display={display} />
                <span className="ghc-row-main">
                  <span className="ghc-row-title">
                    <span className="ghc-row-title-text">{item.title}</span>
                    {labelsOf(item).map(label => <LabelPill key={label} name={label} />)}
                  </span>
                  {meta}
                </span>
                {!item.read && <span className="ghc-row-side"><span className="repo-update-unread" title="Unread"><span className="ghc-visually-hidden">Unread</span></span></span>}
              </>
              return <li key={item.id} className="ghc-row repo-update-item" data-read={item.read} data-kind={item.kind}>
                {viewFlow !== undefined && item.number !== undefined ?
                  <button type="button" className="ghc-row-btn" data-flow={viewFlow}
                    onClick={() => actions.onRunCommand(viewFlow, `${item.number} ${repo}`)}>{body}</button> :
                  <span className="ghc-row-btn repo-update-static">{body}</span>}
              </li>
            })}
          </ul>}
        <div className="repo-update-actions">
          <span className="repo-update-unread-count">{unread === 0 ? "All read" : unread === 1 ? "1 unread" : `${unread} unread`}</span>
          <Button size="sm" variant="outline" data-flow="repo.overview" onClick={() => actions.onRunCommand("repo.overview", repo)}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </Button>
          {unread > 0 && <Button size="sm" data-flow="notifications.read-update"
            onClick={() => actions.onRunCommand("notifications.read-update", card.id)}>
            <Octicon name="check" /> Mark all read
          </Button>}
        </div>
      </div>
    }
  }
}
