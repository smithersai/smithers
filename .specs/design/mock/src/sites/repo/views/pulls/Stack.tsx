import { HeldCodeChange } from "../../ui/HeldCodeChange"
import { pluralize } from "../../ui/pluralize"
import { useEffect, useRef, useState } from "react"
import { useMock } from "../../../core/mock"
import { Link, navigate } from "../../../core/router"
import { issues, MOCK_NOW, pull, repo, run, to } from "../../fixtures"
import type { Check, StackItem } from "../../fixtures/types"
import { Empty, Failed, Loading, registerSlash, SignInWall, useView } from "../../frame"
import { ViewFrame as RepoFrame } from "../checklist/ViewFrame"
import { Box, PageHeader, PersonChip, RelTime, StateIcon, toast } from "../../ui"
import { sameDecision } from "../../frame/waiting"
import { useRunRecords } from "../runs/shared"
import { currentStack, FamilyNav, FormCard, githubPull, isLandingQueue, localPull, now, reviewIsNext, stackItemTitle, stackTitle, useLocal, viewer } from "./shared"

export const StackLoading = () => <Loading rows={7} />
export const StackError = () => (
  <Failed what={`the ${stackTitle()}`} reason={`The ${stackTitle()} service didn't respond. Your order hasn't changed.`} />
)
export const StackEmpty = () => (
  <Empty title={`Nothing in the ${stackTitle()}.`}>
    {!isLandingQueue() && <p className="repo-ui-muted">Make a TODO from an issue or a line of code.</p>}
  </Empty>
)
export const StackSignedOut = () => <SignInWall act={`change the ${stackTitle()}`} />
export const StackReader = () => (
  <p className="repo-pulls-readonly" role="note">
    Read-only. Only repository members can change the {stackTitle()}.
  </p>
)

const Elapsed = ({ item }: { item: StackItem }) => {
  const started = item.run ? (run(item.run)?.started ?? item.updated) : item.updated
  const [seconds, setSeconds] = useState(() =>
    Math.max(0, Math.floor((Date.parse(MOCK_NOW) - Date.parse(started)) / 1000))
  )
  useEffect(() => {
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <time className="repo-pulls-elapsed" aria-label={`${Math.floor(seconds / 60)} ${pluralize(Math.floor(seconds / 60), "minute")} elapsed`}>
      {Math.floor(seconds / 60)}m {String(seconds % 60).padStart(2, "0")}s
    </time>
  )
}

export const stackCheckSummary = (checks: Check[]) => !checks.length ? "Check evidence unavailable"
  : checks.some(check => check.state === "failure") ? "Checks failed"
  : checks.every(check => check.state === "success") ? "Checks passed"
  : "Checks incomplete"

const StackState = ({ item }: { item: StackItem }) => {
  const { flags } = useMock()
  const linked = item.pull ? pull(item.pull) : undefined
  const label =
    item.state === "needs-answer"
      ? "Needs an answer"
      : item.state === "working"
        ? isLandingQueue() ? "Landing" : "Working"
        : item.state === "ready"
          ? linked && flags.as === "in" && flags.role === "member" && reviewIsNext(localPull(linked)) ? "Checks passed. Your review is next." : stackCheckSummary(linked ? localPull(linked).checks : []) + (linked && localPull(linked).checks.length && localPull(linked).checks.every(check => check.state === "success") ? "." : "")
          : item.state === "failed"
            ? isLandingQueue() ? "Refused" : "Failed"
            : item.state === "merged"
              ? isLandingQueue() ? "Landed" : "Merged"
              : "Queued"
  return (
    <span className={`repo-pulls-stack-state repo-pulls-stack-state-${item.state}`}>
      {item.state !== "ready" && <StateIcon
        state={
          item.state === "needs-answer"
            ? "waiting"
            : item.state === "working"
              ? "running"
              : item.state
        }
      />}
      {label}
      {item.state === "working" && <Elapsed item={item} />}
    </span>
  )
}

export const StackReady = ({ filter }: { filter: string }) => {
  const { flags } = useMock()
  const [items, setItems] = useLocal<StackItem[]>(
    flags.data === "empty" ? "stack-empty" : "stack",
    currentStack(flags.data === "empty"), false
  )
  const [add, setAdd] = useState(false)
  const [title, setTitle] = useState("")
  const [issue, setIssue] = useState("")
  const [retry, setRetry] = useState<StackItem | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const serial = useRef(0)
  const writable = flags.as === "in" && flags.role === "member"
  const canAdd = repo.config.stack?.addTodo !== false
  const data = [...items]
    .sort((a, b) => a.order - b.order)
    .map((item) => {
      const linked = item.pull ? pull(item.pull) : undefined
      return linked && localPull(linked).state === "merged"
        ? { ...item, state: "merged" as const }
        : item
    })
    .map(item => ({ ...item, title: stackItemTitle(item.title) }))
  const visible = data.filter((item) =>
    filter === "needs-you"
      ? item.state === "needs-answer" || (item.state === "ready" && item.owner === viewer())
      : filter === "working"
        ? item.state === "working"
        : filter === "failed"
          ? item.state === "failed"
          : true
  )
  const first = visible.find(item => item.state === "needs-answer" && item.owner === viewer())
  const failed = visible.find(item => item.state === "failed")
  const held = flags.host === "hosted" && flags.landing === "install"
  const change = (id: string, patch: Partial<StackItem>) =>
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch, updated: now() } : item))
    )
  const move = (id: string, target: number) => {
    if (!writable) return
    const ordered = [...items].sort((a, b) => a.order - b.order)
    const index = ordered.findIndex((item) => item.id === id)
    if (index < 0 || target < 0 || target >= ordered.length || index === target) return
    const [item] = ordered.splice(index, 1)
    ordered.splice(target, 0, item)
    setItems(ordered.map((entry, i) => ({ ...entry, order: i + 1 })))
    setAnnouncement(`${stackItemTitle(item.title)} moved to position ${target + 1}.`)
    toast(`Moved to position ${target + 1}.`)
  }
  const focusQuestion = (id = first?.id) => {
    if (!id) return
    const element = document.getElementById(`repo-pulls-stack-${id}`)
    element?.scrollIntoView({ behavior: "smooth", block: "center" })
    element
      ?.querySelector<HTMLButtonElement>(".repo-pulls-answer-options button")
      ?.focus({ preventScroll: true })
  }
  const { decisions, decide } = useRunRecords()
  const answer = (id: string, option: string) => {
    const item = items.find(item => item.id === id && item.state === "needs-answer")
    if (!writable || item?.owner !== viewer() || !item.question?.options.includes(option)) return
    const approval = decisions.find(decision => sameDecision(item, decision) && decision.state === "waiting")
    if (approval && (approval.askedOf !== viewer() || !approval.options.includes(option))) return
    if (approval) decide(approval, option)
    change(id, { state: "working", question: undefined })
    if (!approval) toast(`Answered: ${option}.`)
  }
  useEffect(() => {
    const dispose = [
      registerSlash("stack.move", {
        purpose: `Move an item in the ${stackTitle()}`,
        fields: [
          { name: "item", label: `${stackTitle()} item`, options: items.map(item => item.id) },
          { name: "position", label: "Position", type: "number", min: 1, options: items.map((_, i) => String(i + 1)) }
        ],
        run: ({ item, position }) => move(item, Number(position) - 1)
      }),
      registerSlash("stack.answer", {
        purpose: `Answer a ${stackTitle()} question`, confirm: false,
        fields: [
          { name: "item", label: `${stackTitle()} item`, options: items.filter(item => item.state === "needs-answer" && item.owner === viewer()).map(item => item.id) },
          { name: "answer", label: "Answer", required: false }
        ],
        run: ({ item: id, answer: option }, { closeAsk }) => {
          const item = items.find(item => item.id === id && item.state === "needs-answer")
          if (!item?.question) throw new Error("This item has no pending question.")
          if (option && !item.question.options.includes(option)) throw new Error(`Choose one of the answers on the ${stackTitle()} item.`)
          closeAsk()
          if (option) answer(id, option)
          else focusQuestion(id)
        }
      }),
      registerSlash("stack.retry", {
        purpose: `Retry a failed ${stackTitle()} item`, confirm: false,
        fields: [{ name: "item", label: `${stackTitle()} item`, options: items.filter(item => item.state === "failed").map(item => item.id) }],
        run: ({ item: id }, { closeAsk }) => {
          const item = items.find(item => item.id === id && item.state === "failed")
          if (!item) throw new Error("This item has no failed run to retry.")
          closeAsk()
          setRetry(item)
        }
      }),
      registerSlash("pull.merge", {
        purpose: "Open merge confirmation", confirm: false,
        fields: [{ name: "pull", label: "Pull request number", type: "number", min: 1 }],
        run: ({ pull: number }, { closeAsk, location }) => {
          if (!pull(Number(number))) throw new Error(`Pull request #${number} was not found.`)
          const query = new URLSearchParams(location.split("?")[1])
          query.delete("filter")
          query.set("merge", String(Date.now()))
          navigate(to(`pull/${number}?${query}`))
          closeAsk()
        }
      })
    ]
    return () => dispose.forEach(cleanup => cleanup())
  }, [items, writable])
  return (
    <div className="repo-pulls-page">
      <div className="repo-pulls-topbar">
        <FamilyNav active="stack" />
        {writable && (first || failed || canAdd) && (
          <div className="repo-ui-actions">
            {first && !add && !retry && (
              <button
                className="repo-ui-btn repo-ui-btn-primary"
                title={`/stack.answer ${first.id}`}
                onClick={() => focusQuestion()}
              >
                Answer the first question
              </button>
            )}
            {!first && failed && !add && !retry && <button className="repo-ui-btn repo-ui-btn-primary" title={`/stack.retry ${failed.id}`} onClick={() => setRetry(failed)}>Retry the first failed item</button>}
            {canAdd && <button
              className="repo-ui-btn"
              title="/stack.add"
              onClick={() => setAdd(!add)}
              aria-expanded={add}
            >
              Add TODO
            </button>}
          </div>
        )}
      </div>
      <PageHeader title={stackTitle()} description={isLandingQueue() ? "Changes in landing order. You land; the queue runs your submitted tests and gates first." : undefined} />
      {flags.as === "out" ? <StackSignedOut /> : flags.role === "reader" && <StackReader />}
      {add && writable && canAdd && (
        <FormCard title="Add TODO" onCancel={() => setAdd(false)}>
          <form
            className="repo-pulls-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (!writable || !canAdd || !title.trim()) return
              const item: StackItem = {
                id: `mock-${Date.now()}-${++serial.current}`,
                order: items.length + 1,
                title: title.trim(),
                state: "queued",
                owner: viewer(),
                updated: now(),
                ...(issue ? { issue: Number(issue) } : {})
              }
              setItems((current) => [...current, item])
              setTitle("")
              setIssue("")
              setAdd(false)
              toast(`TODO added to the ${stackTitle()}.`)
            }}
          >
            <label htmlFor="repo-pulls-todo-title">Title</label>
            <input
              autoFocus
              className="repo-ui-input"
              id="repo-pulls-todo-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
            <label htmlFor="repo-pulls-todo-issue">
              Issue <span className="repo-ui-muted">(optional)</span>
            </label>
            <select
              className="repo-ui-input"
              id="repo-pulls-todo-issue"
              value={issue}
              onChange={(event) => setIssue(event.target.value)}
            >
              <option value="">No linked issue</option>
              {issues
                .filter((issue) => issue.state === "open")
                .map((issue) => (
                  <option value={issue.n} key={issue.n}>
                    #{issue.n} {issue.title}
                  </option>
                ))}
            </select>
            <button className="repo-ui-btn repo-ui-btn-primary" title="/stack.add" disabled={!title.trim()}>
              Add TODO
            </button>
          </form>
        </FormCard>
      )}
      <nav className="repo-pulls-stack-filters" aria-label={`Filter the ${stackTitle()}`}>
        {[
          ["all", "All"],
          ["needs-you", "Needs you"],
          ["working", "Working"],
          ["failed", "Failed"]
        ].map(([value, label]) => (
          <Link
            key={value}
            to={to(`stack?filter=${value}`)}
            aria-current={(filter || "all") === value ? "page" : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
      <p className="repo-ui-sr" role="status">
        {announcement}
      </p>
      {!data.length ? (
        <Box>
          <StackEmpty />
        </Box>
      ) : !visible.length ? (
        <Box>
          <Empty
            title="Nothing here."
            action={
              <Link className="repo-ui-btn" to={to("stack")}>
                View the whole {stackTitle()}
              </Link>
            }
          />
        </Box>
      ) : (
        <ol className="repo-pulls-stack-list">
          {visible.map((item) => {
            const index = data.findIndex((entry) => entry.id === item.id)
            return (
              <li
                className={`repo-pulls-stack-item repo-pulls-stack-item-${item.state}`}
                key={item.id}
                id={`repo-pulls-stack-${item.id}`}
                value={item.order}
                onDragOver={(event) => {
                  if (writable && dragging) event.preventDefault()
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragging) move(dragging, index)
                  setDragging(null)
                }}
              >
                <div className="repo-pulls-stack-order">
                  {writable && (
                    <span
                      className="repo-pulls-drag"
                      draggable
                      aria-label={`Drag ${item.title} to reorder`}
                      title={`/stack.move ${item.id}`}
                      onDragStart={(event) => {
                        setDragging(item.id)
                        event.dataTransfer.effectAllowed = "move"
                        event.dataTransfer.setData("text/plain", item.id)
                      }}
                      onDragEnd={() => setDragging(null)}
                    >
                      ⠿
                    </span>
                  )}
                  <span className="repo-pulls-order-number">{item.order}</span>
                  {writable && (
                    <div className="repo-pulls-move-controls">
                      <button
                        disabled={index === 0}
                        title={`/stack.move ${item.id} ${item.order - 1}`}
                        aria-label={`Move ${item.title} up`}
                        onClick={() => move(item.id, index - 1)}
                      >
                        ↑
                      </button>
                      <button
                        disabled={index === data.length - 1}
                        title={`/stack.move ${item.id} ${item.order + 1}`}
                        aria-label={`Move ${item.title} down`}
                        onClick={() => move(item.id, index + 1)}
                      >
                        ↓
                      </button>
                    </div>
                  )}
                </div>
                <div className="repo-pulls-stack-main">
                  <div className="repo-pulls-stack-title">
                    <h2>
                      {item.pull ? (
                        <Link to={to(`pull/${item.pull}`)}>{item.title}</Link>
                      ) : item.issue ? (
                        <Link to={to(`issues/${item.issue}`)}>{item.title}</Link>
                      ) : (
                        item.title
                      )}
                    </h2>
                    <StackState item={item} />
                  </div>
                  <div className="repo-pulls-meta">
                    {item.issue && <Link to={to(`issues/${item.issue}`)}>Issue #{item.issue}</Link>}
                    {item.pull && <Link to={to(`pull/${item.pull}`)}>Pull #{item.pull}</Link>}
                    {item.run && <Link to={to(`runs/${item.run}`)}>{item.run}</Link>}
                    <RelTime date={item.updated} />
                  </div>
                  {item.state === "needs-answer" && item.question && (
                    <div className="repo-pulls-stack-question">
                      <p>{item.question.text}</p>
                      <div className="repo-pulls-answer-options">
                        {writable && item.owner === viewer() &&
                          item.question.options.map((option) => (
                            <button
                              className="repo-ui-btn"
                              key={option}
                              title={`/stack.answer ${item.id} ${option}`}
                              onClick={() => answer(item.id, option)}
                            >
                              {option}
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                  {item.state === "failed" && (
                    <div className="repo-pulls-stack-failure">
                      <p>{item.failure}</p>
                      {writable && (
                        <button
                          className="repo-ui-btn"
                          title={`/stack.retry ${item.id}`}
                          onClick={() => setRetry(item)}
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                  {item.state === "ready" && item.pull && writable && (
                    <div className="repo-pulls-stack-merge">
                      {flags.host === "install" ? (
                        <Link
                          className="repo-ui-btn"
                          title={`/pull.merge ${item.pull}`}
                          to={to(`pull/${item.pull}?merge=1&host=install`)}
                        >
                          Merge
                        </Link>
                      ) : (
                        <a
                          className="repo-ui-btn"
                          title={`/pull.merge-on-github ${item.pull}`}
                          href={githubPull(item.pull)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Merge on GitHub
                        </a>
                      )}
                      {held && (
                        <span className="repo-ui-muted">
                          You merge on GitHub.
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <PersonChip login={item.owner} compact />
              </li>
            )
          })}
        </ol>
      )}
      {retry && writable && (
        <FormCard title={`Retry “${stackItemTitle(retry.title)}”?`} onCancel={() => setRetry(null)}>
          {held ? (
            <>
              <HeldCodeChange />
            </>
          ) : flags.hosted === "paused" && flags.host === "hosted" ? (
            <p>Hosted machines are paused.</p>
          ) : flags.model === "none" ? (
            <Link to={to("settings/models")} className="repo-ui-btn">
              Connect a model
            </Link>
          ) : (
            <>
              <p className="repo-ui-muted">{retry.failure}</p>
              <button
                className="repo-ui-btn repo-ui-btn-primary"
                title={`/stack.retry.confirm ${retry.id}`}
                onClick={() => {
                  if (!writable) return
                  change(retry.id, { state: "queued", failure: undefined })
                  setRetry(null)
                  toast("Retry queued.")
                }}
              >
                Confirm retry
              </button>
            </>
          )}
        </FormCard>
      )}
    </div>
  )
}

export const Stack = ({ filter }: { filter: string }) => {
  const { flags } = useMock()
  const state = useView(`stack:${repo.slug}`)
  return (
    <RepoFrame
      tab="pulls"
      title={`${stackTitle()} · ${repo.slug}`}
      askView="stack"
      askContext={`the ${stackTitle()} in ${repo.slug}`}
    >
      {state === "loading" ? (
        <StackLoading />
      ) : state === "error" ? (
        <StackError />
      ) : (
        <StackReady key={`${repo.slug}:${filter}:${flags.data}`} filter={filter} />
      )}
    </RepoFrame>
  )
}
