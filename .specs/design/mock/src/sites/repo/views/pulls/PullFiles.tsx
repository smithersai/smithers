import { pluralize } from "../../ui/pluralize"
import { WriteControl } from "../../frame/WriteControl"
import { Empty } from "../../frame"
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react"
import { useMock } from "../../../core/mock"
import { useLocation } from "../../../core/router"
import type { DiffFile, DiffSide, Review, ReviewComment } from "../../fixtures/types"
import { Box, Icon, Markdown, toast } from "../../ui"
import { ReviewThread } from "./Conversation"
import { FormCard, now, reviewSide, useLocal, viewer, type PullDetailProps } from "./shared"

/* DiffView has no line or annotation slots. This local extension keeps its unified-diff anatomy. */
const ReviewDiff = ({
  n,
  file,
  comments,
  renderThread,
  onLine,
  selected,
  composer
}: {
  n: number
  file: DiffFile
  comments: ReviewComment[]
  renderThread: (comment: ReviewComment, index: number) => ReactNode
  onLine: (line: number, side: DiffSide) => void
  selected?: { line: number; side: DiffSide }
  composer?: ReactNode
}) => {
  const { flags } = useMock()
  const shown = new Set<number>()
  let composerShown = false
  return (
    <div className="repo-pulls-diff-lines" role="table" aria-label={`Changes in ${file.path}`}>
      {file.lines.map((line, index) => {
        const number = line.new ?? line.old
        const side = line.kind === "del" ? "old" : "new"
        const isSelected = selected !== undefined && line[selected.side] === selected.line
        const threads = comments
          .map((comment, i) => ({ comment, i }))
          .filter(
            ({ comment, i }) =>
              comment.path === file.path && line[reviewSide(comment, file)] === comment.line && !shown.has(i)
          )
        threads.forEach(({ i }) => shown.add(i))
        const showComposer = Boolean(composer && isSelected && !composerShown)
        if (showComposer) composerShown = true
        return (
          <Fragment key={index}>
            <div
              role="row"
              className={`repo-pulls-diff-line repo-pulls-diff-${line.kind}`}
              data-selected={line.kind !== "hunk" && number !== undefined && isSelected || undefined}
            >
              <span role="cell" className="repo-pulls-line-old">
                {line.old}
              </span>
              <span role="cell" className="repo-pulls-line-new">
                {number !== undefined && (flags.as === "out" ? <span>{line.new ?? line.old}</span> : (
                  <button
                    title={`/pull.comment-line ${n} ${file.path}:${number} ${side}`}
                    aria-label={`Comment on ${file.path} line ${number}`}
                    onClick={() => onLine(number, side)}
                  >
                    {line.new ?? line.old}
                  </button>
                ))}
              </span>
              <code role="cell">
                <span aria-hidden="true">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                </span>
                {line.text || " "}
              </code>
            </div>
            {threads.map(({ comment, i }) => (
              <div className="repo-pulls-inline-thread" key={`thread:${i}`}>
                {renderThread(comment, i)}
              </div>
            ))}
            {showComposer && <div className="repo-pulls-inline-thread">{composer}</div>}
          </Fragment>
        )
      })}
      {comments.map((comment, index) =>
        comment.path === file.path && !shown.has(index) ? (
          <div className="repo-pulls-inline-thread" key={`outside:${index}`}>
            {renderThread(comment, index)}
          </div>
        ) : null
      )}
    </div>
  )
}

export const PullFiles = ({ item, update }: PullDetailProps) => {
  const { flags } = useMock()
  const location = useLocation()
  const query = new URLSearchParams(location.split("?")[1])
  const [reviewOpen, setReviewOpen] = useState(query.has("review"))
  const [decision, setDecision] = useState<Review["state"]>("commented")
  const [body, setBody] = useState("")
  const [viewed, setViewed] = useLocal<string[]>(`viewed:${item.n}`, [])
  const [pending, setPending] = useLocal<ReviewComment[]>(`pending:${item.n}`, [])
  const [line, setLine] = useState<{ path: string; line: number; side: DiffSide } | null>(null)
  const [lineBody, setLineBody] = useState("")
  const reviewForm = useRef<HTMLDivElement>(null)
  const currentFile = query.get("file")
  const queryReview = query.has("review")
  const member = flags.role === "member"
  const own = item.author === viewer()
  const allowDecision = member && !own
  const allComments = [...item.reviewComments, ...pending]
  const additions = item.files.reduce((total, file) => total + file.additions, 0)
  const deletions = item.files.reduce((total, file) => total + file.deletions, 0)
  const fileId = (path: string) => `repo-pulls-file-${encodeURIComponent(path)}`
  useEffect(() => {
    if (reviewOpen) reviewForm.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus()
  }, [reviewOpen])
  useEffect(() => {
    if (queryReview) {
      setReviewOpen(true)
      const choice = new URLSearchParams(location.split("?")[1]).get("decision")
      if (choice === "commented" || allowDecision && (choice === "approved" || choice === "changes_requested")) setDecision(choice)
    }
  }, [queryReview, location, allowDecision])
  useEffect(() => {
    if (!allowDecision) setDecision("commented")
  }, [allowDecision])
  useEffect(() => {
    if (currentFile)
      document.getElementById(fileId(currentFile))?.scrollIntoView({ block: "center" })
  }, [currentFile])
  const addLine = (asReview: boolean) => {
    if (!line || !lineBody.trim() || flags.as !== "in") return
    const comment = {
      ...line,
      body: lineBody.trim(),
      author: viewer(),
      date: now(),
      resolved: false
    }
    if (asReview) {
      setPending((current) => [...current, comment])
      setReviewOpen(true)
      toast("Comment added to your pending review.")
    } else {
      update((current) => ({ ...current, reviewComments: [...current.reviewComments, comment] }))
      toast("Line comment added.")
    }
    setLine(null)
    setLineBody("")
  }
  const submit = () => {
    if (flags.as !== "in" || (decision !== "commented" && !allowDecision)) return
    if (decision === "changes_requested" && !body.trim()) return
    if (decision === "commented" && !body.trim() && !pending.length) return
    update((current) => ({
      ...current,
      reviews: [
        ...current.reviews,
        {
          author: viewer(),
          date: now(),
          state: decision,
          body:
            body.trim() || (decision === "approved" ? "Approved." : "Left comments on the diff.")
        }
      ],
      reviewComments: [...current.reviewComments, ...pending]
    }))
    setPending([])
    setBody("")
    setReviewOpen(false)
    toast(
      decision === "approved"
        ? "Review submitted: approved."
        : decision === "changes_requested"
          ? "Review submitted: changes requested."
          : "Review submitted."
    )
  }
  return (
    <div className="repo-pulls-files">
      <div className="repo-pulls-files-toolbar">
        <div className="repo-pulls-meta">
          <strong>{item.files.length} changed {pluralize(item.files.length, "file")}</strong>
          <span className="repo-ui-add">+{additions}</span>
          <span className="repo-ui-del">−{deletions}</span>
          <span>
            {viewed.length} / {item.files.length} viewed
          </span>
        </div>
        {item.files.length > 0 && <WriteControl primary act="review changes"><button
          className={`repo-ui-btn${reviewOpen ? "" : " repo-ui-btn-primary"}`}
          title={`/pull.review ${item.n}`}
          aria-expanded={reviewOpen}
          onClick={() => setReviewOpen(!reviewOpen)}
        >
          {flags.as === "out"
            ? "Sign in to review"
            : `Review changes${pending.length ? ` (${pending.length})` : ""}`}
        </button></WriteControl>}
      </div>
      {item.files.length > 0 && reviewOpen && flags.as === "in" && (
        <div ref={reviewForm}>
          <FormCard title="Review changes" onCancel={() => setReviewOpen(false)}>
            {(
              <form
                className="repo-pulls-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  submit()
                }}
              >
                <label htmlFor="repo-pulls-review-body">Review</label>
                <textarea
                  id="repo-pulls-review-body"
                  className="repo-ui-input"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={4}
                  placeholder="Leave a review…"
                  required={
                    decision === "changes_requested" ||
                    (decision === "commented" && !pending.length)
                  }
                />
                <fieldset className="repo-pulls-review-decisions">
                  <legend className="repo-ui-sr">Review decision</legend>
                  {(
                    [
                      ["commented", "Comment"],
                      ["approved", "Approve"],
                      ["changes_requested", "Request changes"]
                    ] as const
                  ).map(([value, label]) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name="decision"
                        value={value}
                        checked={decision === value}
                        disabled={value !== "commented" && !allowDecision}
                        onChange={() => setDecision(value)}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
                {!allowDecision && (
                  <p className="repo-ui-muted">
                    {own
                      ? "You can comment on your own pull request. Another member must approve it."
                      : "Only repository members can approve or request changes. You can comment."}
                  </p>
                )}
                <button
                  className="repo-ui-btn repo-ui-btn-primary"
                  title={`/pull.review.submit ${item.n} ${decision}`}
                  disabled={decision === "commented" && !body.trim() && !pending.length}
                >
                  Submit review
                </button>
              </form>
            )}
          </FormCard>
        </div>
      )}
      {!item.files.length ? <Empty title="No changed files" /> : <div className="repo-pulls-files-layout">
        <nav className="repo-pulls-file-tree" aria-label="Changed files">
          <h2>Files changed</h2>
          {item.files.map((file) => (
            <button
              key={file.path}
              className="repo-pulls-file-link"
              title={`/pull.file ${item.n} ${file.path}`}
              onClick={() =>
                document
                  .getElementById(fileId(file.path))
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              <Icon name="file" size={14} />
              <span>{file.path}</span>
              {viewed.includes(file.path) && <Icon name="check" size={13} />}
            </button>
          ))}
        </nav>
        <div className="repo-pulls-file-content">
          {item.files.map((file) => (
            <section className="repo-pulls-diff" key={file.path} id={fileId(file.path)}>
              <header className="repo-pulls-diff-header">
                <Icon name="file" size={15} />
                <strong>
                  {file.from ? `${file.from} → ` : ""}
                  {file.path}
                </strong>
                <span className="repo-ui-add">+{file.additions}</span>
                <span className="repo-ui-del">−{file.deletions}</span>
                <WriteControl><label className="repo-pulls-viewed">
                  <input
                    type="checkbox"
                    checked={viewed.includes(file.path)}
                    title={`/pull.viewed ${item.n} ${file.path}`}
                    onChange={(event) =>
                      setViewed((current) =>
                        event.target.checked
                          ? [...current, file.path]
                          : current.filter((path) => path !== file.path)
                      )
                    }
                  />
                  Viewed
                </label></WriteControl>
              </header>
              <ReviewDiff
                n={item.n}
                file={file}
                comments={allComments}
                selected={
                  line?.path === file.path
                    ? line
                    : currentFile === file.path && query.has("line")
                      ? { line: Number(query.get("line")), side: query.get("side") === "old" ? "old" : "new" }
                      : undefined
                }
                onLine={(number, side) => {
                  setLine({ path: file.path, line: number, side })
                  setLineBody("")
                }}
                renderThread={(comment, index) =>
                  index < item.reviewComments.length ? (
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
                        toast(
                          comment.resolved ? "Conversation reopened." : "Conversation resolved."
                        )
                      }}
                    />
                  ) : (
                    <Box header="Pending review">
                      <div className="repo-pulls-card-body">
                        <Markdown source={comment.body} dense />
                      </div>
                    </Box>
                  )
                }
                composer={
                  flags.as === "in" && line?.path === file.path && (
                    <FormCard
                      title={`Comment on ${line.path}:${line.line}`}
                      onCancel={() => setLine(null)}
                    >
                      {(
                        <form
                          className="repo-pulls-form"
                          onSubmit={(event) => {
                            event.preventDefault()
                            addLine(false)
                          }}
                        >
                          <label htmlFor="repo-pulls-line-comment">Comment</label>
                          <textarea
                            autoFocus
                            id="repo-pulls-line-comment"
                            className="repo-ui-input"
                            value={lineBody}
                            onChange={(event) => setLineBody(event.target.value)}
                            rows={3}
                            required
                          />
                          <div className="repo-ui-actions">
                            <button
                              className="repo-ui-btn"
                              title={`/pull.comment-line ${item.n} ${line.path}:${line.line} ${line.side}`}
                              disabled={!lineBody.trim()}
                            >
                              Add single comment
                            </button>
                            <button
                              type="button"
                              className="repo-ui-btn"
                              title={`/pull.review.start ${item.n}`}
                              disabled={!lineBody.trim()}
                              onClick={() => addLine(true)}
                            >
                              {pending.length ? "Add to review" : "Start a review"}
                            </button>
                          </div>
                        </form>
                      )}
                    </FormCard>
                  )
                }
              />
            </section>
          ))}
        </div>
      </div>}
    </div>
  )
}
