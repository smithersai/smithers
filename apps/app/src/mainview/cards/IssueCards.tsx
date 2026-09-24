import { flowAction, flowProps } from "../flows/FlowAction"
/*
 * The issues cards: the list ("issue-list") and the detail ("issue"), laid out
 * like GitHub's Issues (ported from multi src/issues: IssuesListView's
 * IssueRow and GithubIssueDetailView). Every act binds a command through
 * onRunCommand — the one delegated dispatch CardView threads from App.tsx
 * (parity.test.ts allowlists it). List rows open the detail (issues.view);
 * the detail carries the comment box (issues.comment), the one state toggle
 * (issues.close / issues.reopen) and, on an unlinked issue, the door onto
 * Every interactive element carries data-flow with its
 * registered command name.
 */
import { flowArgs } from "../flows/FlowArgs"
import { Button, Markdown } from "@smthrs/ui"
import { useState } from "react"
import type { Card } from "../state/AppState"
import { dateLabel } from "../Timestamps"
import { trustedHttpsUrl } from "../state/seams/SeamContext"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import {
  AvatarStack,
  CommentBox,
  issueDisplay,
  LabelPill,
  people,
  RelativeTime,
  repoLabel,
  SideSection,
  StateIcon,
  StatePill
} from "./GithubParts"
import { Octicon } from "./Octicon"

export interface IssueCardActions {
  readonly onRunCommand: RunCommand
}


type IssueRow = Extract<Card, { kind: "issue-list" }>["payload"]["issues"][number] & IssueExtras
type IssuePayload = Extract<Card, { kind: "issue" }>["payload"] & IssueExtras

/** Avatar-bearing people as a read may carry them ({ login, avatar }). */
type PersonRow = { readonly login: string; readonly avatar?: string | undefined }

/**
 * GitHub facts the cards render when a read carries them. They are not in the
 * rpc card schema today (a zod parse strips them), so live cards fall back to
 * what the schema has; any read can supply them.
 */
interface IssueExtras {
  readonly createdAt?: string | null
  readonly assignees?: ReadonlyArray<PersonRow>
  /** Label name to hex color, with or without the #. */
  readonly labelColors?: Readonly<Record<string, string>>
  readonly authorAvatar?: string
}

const IssueListRow = ({ repo, issue, onRunCommand }: { readonly repo: string; readonly issue: IssueRow } & IssueCardActions) => {
  const extra = issue
  const labels = issue.labels ?? []
  const assignees = people(issue.assignees)
  return (
    <li
      className="world-card-row ghc-row"
      data-issue={issue.number}
      data-good-first={labels.includes("good first issue") ? "true" : undefined}
    >
      <button
        type="button"
        className="ghc-row-btn"
        {...flowAction(onRunCommand, "issues.view", flowArgs("issues.view", { number: issue.number, repo, source: issue.source }))}
      >
        <StateIcon display={issueDisplay(issue.state)} />
        <span className="ghc-row-main">
          <span className="ghc-row-title">
            <span className="ghc-row-title-text">{issue.title}</span>
            {labels.map((label) => <LabelPill key={label} name={label} color={extra.labelColors?.[label]} />)}
          </span>
          <span className="ghc-row-meta">
            #{issue.number}
            {extra.createdAt != null ?
              <>
                {" · "}
                {issue.author !== null ? <span className="ghc-author-muted">{issue.author} </span> : null}
                opened <RelativeTime iso={extra.createdAt} />
              </> :
              <>
                {issue.author !== null ? <> · opened by <span className="ghc-author-muted">{issue.author}</span></> : null}
                {issue.updatedAt !== null ? <> · updated <RelativeTime iso={issue.updatedAt} /></> : null}
              </>}
            {issue.source === "github" ? " · GitHub" : null}
          </span>
        </span>
        <span className="ghc-row-side">
          {assignees.length > 0 ? <AvatarStack people={assignees} /> : null}
          {issue.comments > 0 ?
            (
              <span className="ghc-row-count" aria-label={`${issue.comments} comments`}>
                <Octicon name="comment" /> {issue.comments}
              </span>
            ) :
            null}
        </span>
      </button>
    </li>
  )
}

export const IssueListCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "issue-list" }> } & IssueCardActions) => {
  const { repo, filter, issues, github } = card.payload
  const open = issues.filter((issue) => issue.state === "open").length
  return (
    <div className="ghc ghc-box" data-testid="issue-list">
      <div className="ghc-toolbar">
        {filter !== "closed" ?
          <span className="ghc-count" data-active={filter === "open" ? "true" : undefined}><Octicon name="issue-opened" /> {open} Open</span> :
          null}
        {filter !== "open" ?
          <span className="ghc-count" data-active={filter === "closed" ? "true" : undefined}><Octicon name="check" /> {issues.length - open} Closed</span> :
          null}
        <span className="ghc-toolbar-repo">{repoLabel(repo)}</span>
      </div>
      {github !== undefined && (github.refusal !== null || github.stale || github.syncError !== null) ?
        (
          <p className="ghc-note">
            {github.refusal !== null
              ? `GitHub: ${github.refusal}`
              : `GitHub updates${github.stale ? " may be out of date" : " couldn't sync"}${github.syncedAt !== null ? ` · last synced ${dateLabel(github.syncedAt)}` : ""}${github.syncError !== null ? `: ${github.syncError}` : ""}`}
          </p>
        ) :
        null}
      {issues.length === 0 ?
        (
          <p className="world-card-empty ghc-empty">
            <Octicon name="issue-opened" size={24} />
            <span>
              {card.body ?? (filter === "all" ? `No issues in ${repoLabel(repo)}.` : `No ${filter} issues in ${repoLabel(repo)}.`)}
            </span>
          </p>
        ) :
        (
          <ul className="ghc-rows">
            {issues.map((issue) => <IssueListRow key={`${issue.source ?? "smithers-cloud"}-${issue.number}`} repo={repo} issue={issue} onRunCommand={onRunCommand} />)}
          </ul>
        )}
    </div>
  )
}

/** The comment composer: its submit rides issues.comment with the number, the text, and the repository. */
const IssueCommentForm = ({ repo, number, onRunCommand }: { readonly repo: string; readonly number: number } & IssueCardActions) => {
  const [text, setText] = useState("")
  const trimmed = text.trim()
  return (
    <form
      className="ghc-composer"
      aria-label={`Comment on issue #${number}`}
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed === "") return
        onRunCommand("issues.comment", flowArgs("issues.comment", { number, text: trimmed, repo }))
        setText("")
      }}
    >
      <label className="ghc-composer-label" htmlFor={`ghc-comment-${repo}-${number}`}>Add a comment</label>
      <textarea
        id={`ghc-comment-${repo}-${number}`}
        className="ghc-composer-input"
        rows={3}
        placeholder="Leave a comment. Markdown is supported."
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit()
        }}
      />
      <div className="ghc-composer-actions">
        <Button type="submit" size="sm" {...flowProps("issues.comment")} disabled={trimmed === ""}>Comment</Button>
      </div>
    </form>
  )
}

export const IssueCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "issue" }> } & IssueCardActions) => {
  const { repo, number, title, state, author, issueBody, labels, comments } = card.payload
  const github = card.payload.source === "github"
  const githubHref = github ? trustedHttpsUrl(card.payload.htmlUrl ?? "", "github.com") : null
  const extra: IssuePayload = card.payload
  const toggleCommand = state === "open" ? "issues.close" : "issues.reopen"
  const assignees = people(extra.assignees)
  return (
    <article className="ghc ghc-detail" data-issue={number}>
      <header className="ghc-detail-head">
        <h3 className="ghc-detail-title">
          {title} <span className="ghc-detail-number">#{number}</span>
        </h3>
        <div className="ghc-detail-sub">
          <StatePill display={issueDisplay(state)} />
          <span>
            <strong className="ghc-author">{author ?? "Someone"}</strong> opened this issue
            {extra.createdAt != null ? <> <RelativeTime iso={extra.createdAt} /></> : null}
            {` · ${comments.length} ${comments.length === 1 ? "comment" : "comments"}`}
          </span>
        </div>
      </header>
      {github ? <nav className="ghc-actions" aria-label="Issue actions">
        {githubHref ? <a href={githubHref} target="_blank" rel="noreferrer">Open on GitHub</a> : null}
      </nav> : <nav className="ghc-actions" aria-label="Issue actions">
        <Button size="sm" variant="outline"  {...flowAction(onRunCommand, "issue.flows", flowArgs("issue.flows", { number, repo }))}>Issue flows</Button>
        <Button size="sm" variant="outline"  {...flowAction(onRunCommand, "issue.repro", flowArgs("issue.repro", { number, repo }))}>Research / repro</Button>
        <Button size="sm" variant="outline"  {...flowAction(onRunCommand, "issue.poc", flowArgs("issue.poc", { number, repo }))}>Proof of concept</Button>
        <Button size="sm"  {...flowAction(onRunCommand, "issue.implement", flowArgs("issue.implement", { number, repo }))}>Implement</Button>
        <Button size="sm" variant="outline"  {...flowAction(onRunCommand, "issue.add-flow", flowArgs("issue.add-flow", { number, repo }))}>Add flow</Button>
      </nav>}
      <div className="ghc-detail-grid">
        <div className="ghc-detail-main">
          <CommentBox author={author} avatarUrl={extra.authorAvatar} createdAt={extra.createdAt} verb="opened this issue">
            {issueBody === "" ?
              <p className="world-card-empty ghc-muted">No description provided.</p> :
              <Markdown className="smithers-card-markdown" content={issueBody} />}
          </CommentBox>
          {comments.map((comment, index) => (
            <CommentBox key={`comment-${index}`} author={comment.author} avatarUrl={(comment as { readonly authorAvatar?: string }).authorAvatar} createdAt={comment.createdAt} verb="commented">
              <Markdown className="smithers-card-markdown" content={comment.commentBody} />
            </CommentBox>
          ))}
          {!github ? <div className="ghc-detail-foot">
            <IssueCommentForm repo={repo} number={number} onRunCommand={onRunCommand} />
            <div className="ghc-actions">
              <Button
                variant="outline"
                size="sm"
                {...flowAction(onRunCommand, toggleCommand, flowArgs(toggleCommand, { number, repo }))}
              >
                <span className={state === "open" ? "ghc-tone-done" : "ghc-tone-open"}>
                  <Octicon name={state === "open" ? "issue-closed" : "issue-opened"} />
                </span>
                {state === "open" ? "Close issue" : "Reopen issue"}
              </Button>
            </div>
          </div> : null}
        </div>
        <aside className="ghc-side" aria-label={`Issue #${number} details`}>
          <SideSection title="Assignees" empty="No one assigned">
            {assignees.length > 0 ? <AvatarStack people={assignees} /> : null}
          </SideSection>
          <SideSection title="Labels">
            {labels.length > 0 ? labels.map((label) => <LabelPill key={label} name={label} color={extra.labelColors?.[label]} />) : null}
          </SideSection>
          <SideSection title="Repository">
            <span className="ghc-mono">{repoLabel(repo)}</span>
          </SideSection>
        </aside>
      </div>
    </article>
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
