/*
 * The Stack card (epic #1745): one repository's mythical stack, live. Counts,
 * the lanes against maxParallel, and the ordered stack, each row naming its
 * issue, where it is, its checks and its pull request. Every button is a
 * registered flow. The same body renders in the chat, maximized, and on the
 * repository homepage (`S.Home.Stack`); the snapshot is the stack seam's live
 * read, never card state.
 */
import type { MythicalItem, MythicalStack } from "@smthrs/rpc/Mythical"
import { Button } from "@smthrs/ui"
import { useContext, useMemo, useSyncExternalStore } from "react"
import { ControllerContext } from "../ControllerContext"
import { flowArgs } from "../flows/FlowArgs"
import { flowAction } from "../flows/FlowAction"
import type { Card } from "../state/AppState"
import type { StackSnapshot } from "../state/seams/StackSeam"
import { ageLabel } from "../Timestamps"
import type { CardFamily, RunCommand } from "./CardFamily"
import { ACTIVE_ITEM_STATES, itemReason, itemStateLabel, itemTitle, laneRows, retryable, stackCounts, stackRows } from "./StackView"

type StackCard = Extract<Card, { kind: "stack" }>
type Failure = NonNullable<StackCard["payload"]["failure"]>

const NO_SNAPSHOTS = { get: () => undefined, subscribe: () => () => {} }

/** The seam's live snapshot of one repository; absent outside a controller. */
export const useStackSnapshot = (repo: string): StackSnapshot | undefined => {
  const snapshots = useContext(ControllerContext)?.stackSnapshots ?? NO_SNAPSHOTS
  return useSyncExternalStore(snapshots.subscribe, () => snapshots.get(repo), () => snapshots.get(repo))
}

/** A one-second clock while a lane runs; released with its reader. */
const useNow = (running: boolean): number => {
  const clock = useMemo(() => ({
    subscribe: (notify: () => void) => {
      if (!running) return () => {}
      const timer = setInterval(notify, 1000)
      return () => clearInterval(timer)
    },
    snapshot: () => Math.floor(Date.now() / 1000) * 1000
  }), [running])
  return useSyncExternalStore(clock.subscribe, clock.snapshot, clock.snapshot)
}

const Title = ({ stack, item }: { readonly stack: MythicalStack; readonly item: MythicalItem }) =>
  item.issue === undefined ? <span className="world-card-title">{itemTitle(stack, item)}</span> : (
    <a href={item.issue.url} target="_blank" rel="noopener noreferrer" className="world-card-title">{itemTitle(stack, item)}</a>
  )

const Checks = ({ item }: { readonly item: MythicalItem }) => {
  if (item.checks === undefined) return null
  if (item.checks.state === "failed") {
    return <span className="world-card-path" data-checks="failed">✗ {item.checks.failed.join(", ")}</span>
  }
  return <span className="world-card-path" data-checks={item.checks.state}>{item.checks.state === "passed" ? "✓" : "…"}</span>
}

const ItemCells = ({ item, repo, onRunCommand }: {
  readonly item: MythicalItem
  readonly repo: string
  readonly onRunCommand: RunCommand
}) => {
  const reason = itemReason(item)
  return (
    <>
      <span className="stack-state" data-state={item.state}>{itemStateLabel(item)}</span>
      <Checks item={item} />
      {item.pullRequest === undefined ? null : (
        <a href={item.pullRequest.url} target="_blank" rel="noopener noreferrer" className="world-card-path">PR #{item.pullRequest.number}</a>
      )}
      {retryable(item) ? (
        <Button size="sm" variant="ghost"
          {...flowAction(onRunCommand, "stack.retry", flowArgs("stack.retry", { id: item.id, repo }))}>Retry</Button>
      ) : null}
      {reason === undefined ? null : <span className="world-card-path stack-reason">{reason}</span>}
    </>
  )
}

const RETRY_FLOW = { bootstrap: "history.bootstrap", backfill: "stack.backfill", parallel: "stack.parallel", retry: "stack.retry" } as const

const FailureRow = ({ message, act, args, onRunCommand }: {
  readonly message: string
  readonly act: Failure["act"] | "read"
  readonly args: string
  readonly onRunCommand: RunCommand
}) => (
  <div role="alert" className="world-card-row stack-failure" data-testid="stack-failure" data-act={act}>
    <span>{message}</span>
    <Button size="sm" {...flowAction(onRunCommand, act === "read" ? "stack.show" : RETRY_FLOW[act], args)}>Retry</Button>
  </div>
)

export interface StackBodyProps {
  readonly repo: string
  readonly snapshot: StackSnapshot | undefined
  readonly failure: Failure | null
  readonly bootstrapping: boolean
  readonly onRunCommand: RunCommand
}

export const StackBody = ({ repo, snapshot, failure, bootstrapping, onRunCommand }: StackBodyProps) => {
  const stack = snapshot?.stack ?? null
  const running = stack !== null && stack.items.some((item) => ACTIVE_ITEM_STATES.has(item.state))
  const now = useNow(running)
  const failures = (
    <>
      {failure === null ? null : <FailureRow message={failure.message} act={failure.act} args={failure.args} onRunCommand={onRunCommand} />}
      {snapshot?.error == null ? null : <FailureRow message={snapshot.error} act="read" args={repo} onRunCommand={onRunCommand} />}
    </>
  )
  if (stack === null || stack.state === "absent") {
    return (
      <div className="world-card-list" data-testid="stack-card">
        {failures}
        {stack === null || bootstrapping ? null : (
          <Button size="sm" data-testid="stack-bootstrap" {...flowAction(onRunCommand, "history.bootstrap", repo)}>Bootstrap</Button>
        )}
      </div>
    )
  }
  const counts = stackCounts(stack)
  return (
    <div className="world-card-list" data-testid="stack-card" data-stack-state={stack.state}>
      {failures}
      {stack.state === "frozen" ? <p role="alert" data-testid="stack-frozen">{stack.reason ?? "frozen"}</p> : null}
      <p className="world-card-row stack-counts" data-testid="stack-counts">
        <span>{counts.changes} {counts.changes === 1 ? "change" : "changes"}</span>
        <span data-testid="stack-lane-count">{counts.busy}/{counts.maxParallel} lanes</span>
        {counts.queued === 0 ? null : <span>{counts.queued} queued</span>}
        {counts.open === 0 ? null : <span>{counts.open} {counts.open === 1 ? "PR" : "PRs"}</span>}
        {counts.blocked === 0 ? null : <span>{counts.blocked} blocked</span>}
        {counts.declined === 0 ? null : <span>{counts.declined} declined</span>}
      </p>
      <div className="world-card-row stack-admin">
        <Button size="sm" variant="ghost" {...flowAction(onRunCommand, "stack.backfill", repo)}>Backfill</Button>
        <Button size="sm" variant="ghost" aria-label="Fewer lanes" disabled={counts.maxParallel <= 1}
          {...flowAction(onRunCommand, "stack.parallel", flowArgs("stack.parallel", { value: counts.maxParallel - 1, repo }))}>−</Button>
        <span data-testid="stack-max-parallel">{counts.maxParallel}</span>
        <Button size="sm" variant="ghost" aria-label="More lanes" disabled={counts.maxParallel >= 8}
          {...flowAction(onRunCommand, "stack.parallel", flowArgs("stack.parallel", { value: counts.maxParallel + 1, repo }))}>+</Button>
      </div>
      <ol className="stack-lanes" aria-label="Lanes" data-testid="stack-lanes">
        {laneRows(stack).map(({ index, workspaceId, item }) => (
          <li key={index} className="world-card-row" data-testid={`stack-lane-${index}`}>
            <span className="world-card-path">{index + 1}</span>
            {item === undefined ? <span className="world-card-path">idle</span> : (
              <>
                <Title stack={stack} item={item} />
                <span className="stack-state" data-state={item.state}>{itemStateLabel(item)}</span>
                <span className="world-card-path" data-testid={`stack-lane-${index}-updated`}>{ageLabel(item.updatedAt, now)}</span>
              </>
            )}
            {workspaceId === undefined ? null : <span className="world-card-path">{workspaceId.slice(0, 8)}</span>}
          </li>
        ))}
      </ol>
      <ol className="stack-rows" aria-label="Stack" data-testid="stack-rows">
        {stackRows(stack).map((row) => row.kind === "item" ? (
          <li key={row.key} className="world-card-row" data-testid={`stack-item-${row.item.id}`}>
            <Title stack={stack} item={row.item} />
            <ItemCells item={row.item} repo={repo} onRunCommand={onRunCommand} />
          </li>
        ) : (
          <li key={row.key} className="world-card-row" data-testid={`stack-change-${row.change.changeId}`}>
            {row.item === undefined ? <span className="world-card-title">{row.change.title}</span> : <Title stack={stack} item={row.item} />}
            <span className="world-card-path">{row.change.changeId.slice(0, 8)}</span>
            {row.item === undefined ? null : <ItemCells item={row.item} repo={repo} onRunCommand={onRunCommand} />}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** The chat card: the seam's live snapshot beside the card's own failure and request. */
export const StackCardBody = ({ card, onRunCommand }: { readonly card: StackCard; readonly onRunCommand: RunCommand }) => {
  const snapshot = useStackSnapshot(card.payload.repo)
  return <StackBody repo={card.payload.repo} snapshot={snapshot} failure={card.payload.failure}
    bootstrapping={card.payload.bootstrap !== undefined} onRunCommand={onRunCommand} />
}

/** The homepage block: the same body, read-only of card state. */
export const HomeStack = ({ title, repo, onRunCommand }: {
  readonly title?: string | undefined
  readonly repo: string
  readonly onRunCommand: RunCommand
}) => {
  const snapshot = useStackSnapshot(repo)
  // Signed out (no read) or before the first answer, the block is absent.
  if (snapshot === undefined) return null
  return <div data-testid="home-stack">{title && <h2>{title}</h2>}
    <StackBody repo={repo} snapshot={snapshot} failure={null} bootstrapping={false} onRunCommand={onRunCommand} /></div>
}

export const stackCardFamily: CardFamily<"stack"> = {
  stack: {
    render: (card, actions) => <StackCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: () => ""
  }
}
