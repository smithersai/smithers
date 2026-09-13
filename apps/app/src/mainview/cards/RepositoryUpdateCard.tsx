import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"

export const repositoryUpdateCardFamily: CardFamily<"repo-update"> = {
  "repo-update": {
    pill: settledPill,
    render: (card, actions) => <div className="repo-update" aria-label="Smithers repository update">
      <p>{card.payload.summary}</p>
      <dl className="repo-update-counts">
        <div><dt>Open issues</dt><dd>{card.payload.openIssues ?? "Unavailable"}</dd></div>
        <div><dt>Open PRs</dt><dd>{card.payload.openPrs ?? "Unavailable"}</dd></div>
        {card.payload.branch && <div><dt>Branch</dt><dd>{card.payload.branch}</dd></div>}
      </dl>
      {card.payload.problems.length > 0 && <p className="repo-update-note">Partial update — {card.payload.problems.join(" ")} Counts cover the activity received.</p>}
      <ul className="repo-update-items">{card.payload.items.map(item => <li key={item.id} data-read={item.read}>
        <span className="repo-update-kind">{item.kind === "pr" ? "PR" : item.kind === "issue" ? "Issue" : "Notification"}{item.number ? ` #${item.number}` : ""}</span>
        <span>{item.title}</span>
        <span className="repo-update-tags">{item.tags.join(" · ")}</span>
      </li>)}</ul>
      <div className="repo-update-actions">
        <button type="button" data-flow="repo.update" onClick={() => actions.onRunCommand("repo.update", card.payload.repo)}>Refresh update</button>
        {card.payload.items.some(item => !item.read) && <button type="button" data-flow="notifications.read-update"
          onClick={() => actions.onRunCommand("notifications.read-update", card.id)}>Mark update read</button>}
      </div>
    </div>
  }
}
