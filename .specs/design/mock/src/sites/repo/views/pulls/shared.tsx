import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react"
import { useMock } from "../../../core/mock"
import { Link } from "../../../core/router"
import { MOCK_NOW, people, repo, stack, to } from "../../fixtures"
import type { Pull, Review, StackItem } from "../../fixtures/types"
import { Denied, SignInWall } from "../../frame"
import { Box, StateIcon } from "../../ui"
import { allIssues } from "../issues/model"

export const viewer = () => people.find((person) => person.role === "owner")?.login ?? repo.owner
export const stackTitle = () => repo.config.stack?.title ?? "Stack"
export const isLandingQueue = () => repo.config.stack?.addTodo === false
export const stackItemTitle = (title: string) => isLandingQueue()
  ? title.replace(/^(?:Landing|Queued for your landing checks|Refused|Landed):\s*/i, "")
  : title

const storageKey = (key: string) => `repo-pulls-v1:${repo.slug}:${key}`

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const value = sessionStorage.getItem(storageKey(key))
    return value ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

export function useLocal<T>(key: string, initial: T, restore = true): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(() => restore ? readLocal(key, initial) : initial)
  const update: Dispatch<SetStateAction<T>> = (next) =>
    setValue((current) => {
      const result = typeof next === "function" ? (next as (previous: T) => T)(current) : next
      try {
        sessionStorage.setItem(storageKey(key), JSON.stringify(result))
      } catch {
        /* Session state still works. */
      }
      setTimeout(() => window.dispatchEvent(new Event("repo-inbox-change")), 0)
      return result
    })
  return [value, update]
}

export const localPull = (item: Pull): Pull => readLocal(`pull:${item.n}`, item)
export const currentStack = (empty = false): StackItem[] => {
  if (empty) return readLocal("stack-empty", [])
  allIssues() // Restore issue/code TODOs on a direct visit after reload.
  const saved = readLocal("stack", stack)
  const nextOrder = Math.max(0, ...saved.map(item => item.order))
  return [...saved, ...stack.filter(item => !saved.some(existing => existing.id === item.id))
    .map((item, index) => ({ ...item, order: nextOrder + index + 1 }))]
}
export const now = () => MOCK_NOW

export function latestReviews(reviews: Review[]): Review[] {
  const latest = new Map<string, Review>()
  reviews.forEach((review) => {
    if (review.state !== "commented") latest.set(review.author, review)
  })
  return [...latest.values()]
}

export const reviewState = (item: Pull) => {
  const latest = latestReviews(item.reviews)
  if (latest.some((review) => review.state === "changes_requested")) return "Changes requested"
  if (latest.some((review) => review.state === "approved")) return "Approved"
  return item.state === "draft" ? "Draft" : "Review required"
}

export const reviewRequested = (item: Pull, login = viewer()) =>
  item.state === "open" && (item.reviewers.length ? item.reviewers.includes(login) : item.agent?.for === login) &&
  !latestReviews(item.reviews).some(review => review.author === login)

export const passedAgentChecks = (item: Pull) => Boolean(item.state === "open" && item.agent && item.checks.length > 0 && item.checks.every(check => check.state === "success"))

export const reviewIsNext = (item: Pull) => passedAgentChecks(item) && reviewRequested(item)

export const checkState = (item: Pull) =>
  !item.checks.length ? "unknown" : item.checks.some((check) => check.state === "failure")
    ? "failure"
    : item.checks.some((check) => check.state === "pending")
      ? "pending"
      : item.checks.every(check => check.state === "success") ? "success" : "skipped"

export const FamilyNav = ({ active }: { active: "pulls" | "stack" }) => (
  <nav className="repo-pulls-family-nav" aria-label="Changes">
    <Link to={to("pulls")} aria-current={active === "pulls" ? "page" : undefined}>
      Pull requests
    </Link>
    <StackLink active={active === "stack"} />
  </nav>
)

const StackLink = ({ active }: { active: boolean }) => {
  const { flags } = useMock()
  const count = currentStack(flags.data === "empty").length
  return (
    <Link to={to("stack")} aria-current={active ? "page" : undefined}>
      {stackTitle()} <span className="repo-ui-counter">{count}</span>
    </Link>
  )
}

export const Access = ({ act, children }: { act: string; children: ReactNode }) => {
  const { flags } = useMock()
  if (flags.as === "out") return <SignInWall act={act} />
  if (flags.role !== "member") return <Denied act={act} />
  return <>{children}</>
}

export const FormCard = ({
  title,
  onCancel,
  children
}: {
  title: string
  onCancel: () => void
  children: ReactNode
}) => (
  <Box className="repo-pulls-form-card" header={title}>
    <div className="repo-pulls-card-body">
      {children}
      <button
        className="repo-ui-btn repo-ui-btn-quiet"
        title="/cancel"
        type="button"
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  </Box>
)

export const PullStatus = ({ state }: { state: Pull["state"] }) => (
  <span className={`repo-pulls-status repo-pulls-status-${state}`}>
    <StateIcon state={state} />
    {state === "draft"
      ? "Draft"
      : state === "merged"
        ? "Merged"
        : state === "closed"
          ? "Closed"
          : "Open"}
  </span>
)

export const githubPull = (n: number) =>
  `${repo.github ?? `https://github.com/${repo.slug}`}/pull/${n}`

export interface PullDetailProps {
  item: Pull
  update: Dispatch<SetStateAction<Pull>>
}
