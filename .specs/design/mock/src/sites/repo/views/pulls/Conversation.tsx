import { HeldCodeChange } from "../../ui/HeldCodeChange"
import { pluralize } from "../../ui/pluralize"
import { WriteControl } from "../../frame/WriteControl"
import { useEffect, useState } from "react"
import { useMock } from "../../../core/mock"
import { Link, useLocation } from "../../../core/router"
import { commit, fmtDate, shortSha, to } from "../../fixtures"
import type { Comment, Pull, ReviewComment } from "../../fixtures/types"
import { SignInWall } from "../../frame"
import {
  AgentMark,
  Box,
  CodeView,

  Markdown,
  PersonChip,
  RelTime,
  StateIcon,
  toast
} from "../../ui"
import {
  Access,
  FormCard,
  githubPull,
  now,
  passedAgentChecks,
  reviewIsNext,
  reviewSide,
  reviewState,
  viewer,
  type PullDetailProps
} from "./shared"

export const CommentCard = ({ comment, label }: { comment: Comment; label?: string }) => (
  <Box
    className="repo-pulls-comment"
    header={
      <div className="repo-pulls-comment-head">
        <PersonChip login={comment.author} />
        <span className="repo-ui-muted">{label ?? "commented"}</span>
        <AgentMark agent={comment.agent} />
        <RelTime date={comment.date} />
      </div>
    }
  >
    <div className="repo-pulls-card-body">
      <Markdown source={comment.body} />
    </div>
  </Box>
)

export const ReviewThread = ({
  comment,
  item,
  onResolve
}: {
  comment: ReviewComment
  item: Pull
  onResolve: () => void
}) => {
  const { flags } = useMock()
  const file = item.files.find(file => file.path === comment.path)
  const side = reviewSide(comment, file)
  const excerpt = file?.lines.find(line => line[side] === comment.line)?.text
  return (
    <Box
      className={`repo-pulls-thread${comment.resolved ? " repo-pulls-thread-resolved" : ""}`}
      header={
        <div className="repo-pulls-thread-head">
          <Link
            to={to(
              `pull/${item.n}/files?file=${encodeURIComponent(comment.path)}&line=${comment.line}&side=${side}`
            )}
          >
            {comment.path}:{comment.line}
          </Link>
          {comment.resolved && <span className="repo-ui-muted">Resolved</span>}
        </div>
      }
    >
      {excerpt && <CodeView code={excerpt} startLine={comment.line} path={comment.path} />}
      <div className="repo-pulls-card-body">
        <div className="repo-pulls-meta">
          <PersonChip login={comment.author} />
          <AgentMark agent={comment.agent} />
          <RelTime date={comment.date} />
        </div>
        <Markdown source={comment.body} dense />
        {flags.as === "in" && flags.role === "member" && (
          <WriteControl><button
            className="repo-ui-btn"
            title={`/pull.thread.${comment.resolved ? "reopen" : "resolve"} ${item.n} ${comment.path}:${comment.line} ${side}`}
            onClick={onResolve}
          >
            {comment.resolved ? "Reopen conversation" : "Resolve conversation"}
          </button></WriteControl>
        )}
      </div>
    </Box>
  )
}

export const MergeBox = ({ item, update }: PullDetailProps) => {
  const { flags } = useMock()
  const location = useLocation()
  const query = new URLSearchParams(location.split("?")[1])
  const [confirm, setConfirm] = useState(query.has("merge"))
  const [fix, setFix] = useState(query.has("fix"))
  const [method, setMethod] = useState("squash")
  useEffect(() => {
    const next = new URLSearchParams(location.split("?")[1])
    setConfirm(next.has("merge"))
    setFix(next.has("fix"))
  }, [location])
  useEffect(() => {
    if (new URLSearchParams(location.split("?")[1]).get("receipt") === "1") {
      document.getElementById("repo-pulls-review-receipt")?.scrollIntoView({ block: "center" })
    }
  }, [location])
  const failure = item.checks.find((check) => check.state === "failure")
  const pending = item.checks.filter((check) => check.state === "pending")
  const review = reviewState(item)
  const conflicts = query.get("conflicts") === "1"
  const threads = item.reviewComments.filter((comment) => !comment.resolved).length
  const evidenceUnavailable = !item.checks.length || !item.commits.length || !item.files.length
  const blocked = Boolean(
    evidenceUnavailable || failure || pending.length || review !== "Approved" || conflicts || threads
  )
  const held = flags.host === "hosted" && flags.landing === "install"
  const merge = () => {
    update((current) => ({
      ...current,
      state: "merged",
      merged: { by: viewer(), date: now(), sha: current.commits.at(-1) ?? "" }
    }))
    setConfirm(false)
    toast(`${viewer()} merged #${item.n} into ${item.base}.`)
  }
  if (item.state === "merged")
    return (
      <Box className="repo-pulls-merge-box">
        <div className="repo-pulls-card-body repo-pulls-merge-complete">
          <StateIcon state="merged" size={24} />
          <div>
            <h2>Merged into {item.base}</h2>
            <p className="repo-ui-muted">
              {item.merged?.by} merged this {item.merged && <RelTime date={item.merged.date} />}
            </p>
          </div>
        </div>
      </Box>
    )
  if (item.state === "closed")
    return (
      <Box>
        <div className="repo-pulls-card-body">
          <h2>This pull request is closed.</h2>
        </div>
      </Box>
    )
  return (
    <Box className="repo-pulls-merge-box">
      <div className="repo-pulls-card-body">
        <details className="repo-pulls-check-summary">
          <summary title={`/pull.checks ${item.n}`}>
            <StateIcon state={!item.checks.length ? "unknown" : failure ? "failure" : pending.length ? "pending" : item.checks.every(check => check.state === "success") ? "success" : "skipped"} />
            <strong>
              {!item.checks.length ? "Check evidence unavailable" : failure
                ? `${failure.name} failed`
                : pending.length
                  ? `${pending.length} ${pluralize(pending.length, "check")} pending`
                  : item.checks.every(check => check.state === "success") ? "All checks passed" : "Checks skipped"}
            </strong>
            <span className="repo-ui-muted">
              {item.checks.filter((check) => check.state === "success").length} /{" "}
              {item.checks.length}
            </span>
          </summary>
          <div className="repo-pulls-check-summary-list">
            {item.checks.map((check) => (
              <Link
                to={to(`pull/${item.n}/checks?check=${encodeURIComponent(check.name)}`)}
                key={check.name}
              >
                <StateIcon state={check.state} />
                <span>{check.name}</span>
                <span className="repo-ui-muted">{check.duration}</span>
              </Link>
            ))}
          </div>
        </details>
        <div className="repo-pulls-merge-requirement">
          <StateIcon state={review === "Approved" ? "approved" : review === "Changes requested" ? "changes_requested" : "pending"} />
          <span>{review}</span>
          {threads > 0 && (
            <span className="repo-ui-muted">
              · {threads} unresolved {pluralize(threads, "conversation")}
            </span>
          )}
        </div>
        <div className="repo-pulls-merge-requirement">
          <StateIcon state={conflicts ? "failure" : "success"} />
          <span>
            {conflicts ? `Conflicts with ${item.base}` : `No conflicts with ${item.base}`}
          </span>
        </div>
      </div>
      <div className="repo-pulls-merge-action">
        {item.state === "draft" ? (
          <Access act="mark a draft ready for review">
            <button
              className="repo-ui-btn repo-ui-btn-primary"
              title={`/pull.ready ${item.n}`}
              onClick={() => {
                update((current) => ({ ...current, state: "open" }))
                toast("Ready for review.")
              }}
            >
              Ready for review
            </button>
          </Access>
        ) : flags.as === "out" ? (
          <SignInWall act="review" />
        ) : flags.role !== "member" ? (
          <p className="repo-ui-muted">
            Members can review and merge.
          </p>
        ) : evidenceUnavailable ? (
          <p className="repo-ui-muted">Evidence unavailable. <a href={githubPull(item.n)} target="_blank" rel="noopener">View on GitHub</a></p>
        ) : failure ? (
          <>
            <p className="repo-pulls-danger">Merge blocked: {failure.name} failed.</p>
            <button
              className={`repo-ui-btn${fix ? "" : " repo-ui-btn-primary"}`}
              title={`/change.fix ${item.n}`}
              onClick={() => setFix(true)}
            >
              Ask the agent to fix it
            </button>
          </>
        ) : blocked ? (
          <>
            <p className="repo-ui-muted">
              {conflicts
                ? "Resolve conflicts before merging."
                : pending.length
                  ? "Waiting for checks to finish."
                  : threads
                    ? "Resolve the review conversations before merging."
                    : "A member's approval is required."}
            </p>
            {!pending.length && !conflicts && (
              <Link
                className="repo-ui-btn repo-ui-btn-primary"
                title={`/pull.review ${item.n}`}
                to={to(`pull/${item.n}/files?review=1`)}
              >
                Review changes
              </Link>
            )}
          </>
        ) : flags.host === "install" ? (
          <button
            className={`repo-ui-btn${confirm ? "" : " repo-ui-btn-primary"}`}
            title={`/pull.merge ${item.n}`}
            onClick={() => setConfirm(true)}
          >
            Review &amp; merge
          </button>
        ) : (
          <>
            <a
              className="repo-ui-btn repo-ui-btn-primary"
              title={`/pull.merge-on-github ${item.n}`}
              href={githubPull(item.n)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Merge on GitHub
            </a>
            {held && (
              <p className="repo-ui-muted">Merge on your install.</p>
            )}
          </>
        )}
        {fix && (
          <FormCard
            title={held ? "Run Smithers locally" : "Ask the agent to fix this check?"}
            onCancel={() => setFix(false)}
          >
            {held ? (
              <>
                <HeldCodeChange />
              </>
            ) : (
              <Access act="request a fix">
                {flags.host === "hosted" && flags.hosted === "paused" ? (
                  <p>Hosted machines are paused.</p>
                ) : flags.model === "none" ? (
                  <Link className="repo-ui-btn" to={to("settings/models")}>
                    Connect a model
                  </Link>
                ) : (
                  <>
                    <p>{failure?.detail}</p>
                    <button
                      className="repo-ui-btn repo-ui-btn-primary"
                      title={`/change.fix.confirm ${item.n}`}
                      onClick={() => {
                        update((current) => ({
                          ...current,
                          checks: current.checks.map((check) =>
                            check.state === "failure"
                              ? { ...check, state: "pending", detail: "Agent fix queued." }
                              : check
                          )
                        }))
                        setFix(false)
                        toast("Fix queued for the agent.")
                      }}
                    >
                      Start fix
                    </button>
                  </>
                )}
              </Access>
            )}
          </FormCard>
        )}
        {confirm && (
          <FormCard
            title={`Merge #${item.n} into ${item.base}?`}
            onCancel={() => setConfirm(false)}
          >
            <Access act="merge this change">
              <p>{viewer()} will merge #{item.n} into <code>{item.base}</code>.</p>
              {flags.host !== "install" ? (
                <>
                  {held && <p className="repo-ui-muted">Merge on your install.</p>}
                  <a className="repo-ui-btn" href={githubPull(item.n)} target="_blank" rel="noopener noreferrer">
                    Merge on GitHub
                  </a>
                </>
              ) : blocked || item.state === "draft" ? (
                <p>Resolve the requirements above before merging.</p>
              ) : (
                <form
                  className="repo-pulls-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    merge()
                  }}
                >
                  <label htmlFor="repo-pulls-merge-method">Merge method</label>
                  <select
                    id="repo-pulls-merge-method"
                    className="repo-ui-input"
                    value={method}
                    onChange={(event) => setMethod(event.target.value)}
                  >
                    <option value="squash">Squash and merge</option>
                    <option value="merge">Create a merge commit</option>
                  </select>
                  <button
                    className="repo-ui-btn repo-ui-btn-primary"
                    title={`/pull.merge.confirm ${item.n}`}
                  >
                    Confirm {method === "squash" ? "squash and merge" : "merge"}
                  </button>
                </form>
              )}
            </Access>
          </FormCard>
        )}
      </div>
    </Box>
  )
}

export const Conversation = ({ item, update }: PullDetailProps) => {
  const { flags } = useMock()
  const [body, setBody] = useState("")
  const timeline = [
    ...item.commits.map((sha) => ({
      kind: "commit" as const,
      date: commit(sha)?.date ?? item.opened,
      sha
    })),
    ...item.reviews.map((review, index) => ({
      kind: "review" as const,
      date: review.date,
      review,
      index
    })),
    ...item.comments.map((comment, index) => ({
      kind: "comment" as const,
      date: comment.date,
      comment,
      index
    }))
  ].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
  return (
    <div className="repo-pulls-conversation">
      <CommentCard
        comment={{ author: item.author, date: item.opened, body: item.body, agent: item.agent }}
        label="opened this pull request"
      />
      <div className="repo-pulls-timeline">
        {timeline.map((event) => {
          if (event.kind === "commit") {
            const entry = commit(event.sha)
            return (
              <div className="repo-pulls-event" key={event.sha}>
                <span className="repo-pulls-event-dot">
                  <StateIcon state="open" />
                </span>
                <div className="repo-pulls-event-main">
                  <span className="repo-ui-muted">
                    {entry?.author ?? item.author} pushed a commit
                  </span>
                  <Link to={to(`commit/${event.sha}`)}>{entry?.title ?? shortSha(event.sha)}</Link>
                  <AgentMark agent={entry?.agent} />
                </div>
                <Link className="repo-pulls-sha" to={to(`commit/${event.sha}`)}>
                  {shortSha(event.sha)}
                </Link>
              </div>
            )
          }
          if (event.kind === "review")
            return (
              <div className="repo-pulls-timeline-card" id={event.index === item.reviews.length - 1 ? "repo-pulls-review-receipt" : undefined} key={`review:${event.index}`}>
                <CommentCard
                  comment={reviewIsNext(item) && flags.as === "in" && flags.role === "member" ? event.review : { ...event.review, body: event.review.body.replace(/Checks passed\. Your review is next\./g, "Checks passed.") }}
                  label={
                    event.review.agent ? "commented" : event.review.state === "approved"
                      ? "approved these changes"
                      : event.review.state === "changes_requested"
                        ? "requested changes"
                        : "reviewed"
                  }
                />
              </div>
            )
          return (
            <div className="repo-pulls-timeline-card" key={`comment:${event.index}`}>
              <CommentCard comment={reviewIsNext(item) && flags.as === "in" && flags.role === "member" ? event.comment : { ...event.comment, body: event.comment.body.replace(/Checks passed\. Your review is next\./g, "Checks passed.") }} />
            </div>
          )
        })}
        {item.reviewComments.map((comment, index) => (
          <div
            className="repo-pulls-timeline-card"
            key={`${comment.path}:${comment.line}:${index}`}
          >
            <ReviewThread
              item={item}
              comment={comment}
              onResolve={() => {
                update((current) => ({
                  ...current,
                  reviewComments: current.reviewComments.map((entry, i) =>
                    i === index ? { ...entry, resolved: !entry.resolved } : entry
                  )
                }))
                toast(comment.resolved ? "Conversation reopened." : "Conversation resolved.")
              }}
            />
          </div>
        ))}
        <div className="repo-pulls-event">
          <span className="repo-pulls-event-dot">
            <StateIcon
              state={!item.checks.length ? "unknown" : item.checks.some(check => check.state === "failure") ? "failure" : item.checks.some(check => check.state === "pending") ? "pending" : item.checks.every(check => check.state === "success") ? "success" : "skipped"}
            />
          </span>
          <Link to={to(`pull/${item.n}/checks`)}>
            {item.checks.length ? `${item.checks.filter(check => check.state === "success").length} of ${item.checks.length} ${pluralize(item.checks.length, "check")} passed` : "Check evidence unavailable"}
          </Link>
          <RelTime date={item.updated} />
        </div>
        {item.merged && (
          <div className="repo-pulls-event">
            <StateIcon state="merged" />
            <span>
              {item.merged.by} merged into <code>{item.base}</code> on {fmtDate(item.merged.date)}
            </span>
          </div>
        )}
      </div>
      <MergeBox item={item} update={update} />
      {flags.as === "out" ? (
        item.state === "merged" || item.state === "closed" ? (
          <SignInWall act="comment" />
        ) : null
      ) : (
        <Box header="Leave a comment">
          <form
            className="repo-pulls-card-body repo-pulls-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!body.trim()) return
              update((current) => ({
                ...current,
                comments: [
                  ...current.comments,
                  { author: viewer(), date: now(), body: body.trim() }
                ]
              }))
              setBody("")
              toast("Comment added.")
            }}
          >
            <label className="repo-ui-sr" htmlFor="repo-pulls-comment">
              Comment
            </label>
            <textarea
              id="repo-pulls-comment"
              className="repo-ui-input"
              rows={5}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Leave a comment…"
              required
            />
            <button
              className="repo-ui-btn"
              title={`/pull.comment ${item.n}`}
              disabled={!body.trim()}
            >
              Comment
            </button>
          </form>
        </Box>
      )}
      {passedAgentChecks(item) && <p className="repo-ui-muted" role={flags.as === "in" && flags.role === "member" && reviewIsNext(item) ? "status" : undefined}>{flags.as === "in" && flags.role === "member" && reviewIsNext(item) ? "Checks passed. Your review is next." : "Checks passed."}</p>}
    </div>
  )
}
