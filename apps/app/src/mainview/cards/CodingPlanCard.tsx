import { runSourceCommand } from "../flows/RunCommand"
import type { Card } from "../state/AppState"
import { codingEvidenceOf } from "./CodingPlan"
import { codingVibeAvailable, codingVibeRequestOf, type WorkflowCatalog } from "./CodingVibe"
import { flowArgs } from "../flows/FlowArgs"
import type { RunCommand } from "./CardFamily"
import { ChangeCommitStrip } from "./ChangeCommitStrip"
import { decodeChangeReceipt, receiptMatchesPlan } from "./tutorial2-agent_change-contract"

type RunCard = Extract<Card, { kind: "run-trace" }>

/** Where a started plan went: the run id the controller recorded on the plan card, and that run's card when it holds one. */
export const startedRunOf = (card: RunCard): { readonly runId: string; readonly cardId?: string } | undefined => {
  const started = card.payload.input?.started
  if (typeof started !== "object" || started === null) return undefined
  const { runId, cardId } = started as { runId?: unknown; cardId?: unknown }
  if (typeof runId !== "string" || runId === "") return undefined
  return typeof cardId === "string" && cardId !== "" ? { runId, cardId } : { runId }
}

/**
 * The plan inside a run card. A tutorial plan card (`change-plan`) IS the
 * plan: its commits, its check, and its one door (Start), or the run it
 * became once started. A tutorial run card (`change`) folds the same plan
 * away under its execution, because the run is now the point. Predicted
 * ownership is visible before execution; recorded receipts arrive through
 * the run journal and the receipt strip.
 */
export const CodingPlanBody = ({ card, onRunCommand: sendRunCommand, workflowCatalogs = [] }: {
  readonly card: RunCard
  readonly onRunCommand: RunCommand
  readonly workflowCatalogs?: ReadonlyArray<WorkflowCatalog>
}) => {
  const onRunCommand = runSourceCommand(card.id, sendRunCommand)
  const { plan, outcome, blockedSpanId, reviewFeedback } = codingEvidenceOf(card)
  if (plan === undefined) return null
  const vibeRequest = codingVibeRequestOf(card)
  const canVibe = vibeRequest !== undefined && codingVibeAvailable(card, workflowCatalogs)
  let receipt
  try {
    const decoded = decodeChangeReceipt(card.payload.input?.tutorialReceipt)
    if (receiptMatchesPlan(decoded, plan, card.payload.repo, card.payload.runId)) receipt = decoded
  } catch { /* Unverified results never draw a parent relation. */ }
  const tutorial = card.payload.kind === "change-plan" || card.payload.kind === "change"
  const planCard = card.payload.kind === "change-plan"
  const selected = plan.changes.find((change) => change.id === card.payload.codingChangeId)
  const reviewSummary = reviewFeedback?.result.findings[0]?.message ?? ""
  const detailsId = `${card.id}-coding-details`
  const change = plan.changes[0]
  const atoms = plan.changes.flatMap(entry => entry.atoms)
  const started = startedRunOf(card)
  return (
    <section className="coding-plan" aria-label="Coding plan" data-plan-card={planCard} data-plan-started={planCard ? card.status !== "active" : undefined}>
      {reviewFeedback === undefined ? null : (
        <div className="coding-plan-notice" aria-label="Coding review feedback">
          <p>Review requested changes. Waiting for the correction result.</p>
          <p>{reviewSummary.length <= 240 ? reviewSummary : `${reviewSummary.slice(0, 240)}…`}</p>
          <button
            type="button"
            className="run-trace-filter"
            data-flow="runs.trace.select"
            onClick={() => onRunCommand("runs.trace.select", `${card.payload.runId} ${reviewFeedback.spanId}`)}
          >
            Inspect review feedback
          </button>
        </div>
      )}
      {outcome === undefined ? null : (
        <div className="coding-plan-notice" aria-label="Coding outcome">
          <p>
            {outcome.status === "validated" ? "Validated" : outcome.status === "changes-requested" ? "Changes requested" : "Blocked"}
            {` after ${outcome.rounds} ${outcome.rounds === 1 ? "round" : "rounds"}.`}
          </p>
          {outcome.blocked === null ? null : <p>{outcome.blocked.message}</p>}
          {vibeRequest === undefined ? null : canVibe ? (
            <button type="button" className="run-trace-filter" data-flow="flow.run"
              onClick={() => onRunCommand("flow.run", flowArgs("flow.run", {
                name: "coding/vibe", input: { requestExecutionId: vibeRequest.requestExecutionId }
              }))}>Vibe this change</button>
          ) : (
            <div>
              <p>Vibe is not available in this workspace's recorded flows.</p>
              <button type="button" className="run-trace-filter" data-flow="flow.list"
                onClick={() => onRunCommand("flow.list")}>Check available flows</button>
            </div>
          )}
          {blockedSpanId === undefined ? null : (
            <button
              type="button"
              className="run-trace-filter"
              data-flow="runs.trace.select"
              onClick={() => onRunCommand("runs.trace.select", `${card.payload.runId} ${blockedSpanId}`)}
            >
              Inspect failed execution
            </button>
          )}
        </div>
      )}
      {tutorial && change !== undefined ? (
        planCard ? (
          <>
            <h4 className="coding-plan-title">{change.title}</h4>
            <p className="coding-plan-intent">{change.intent}</p>
            <PlannedCommits card={card} atoms={atoms} />
            {change.checks.filter(check => check.tier === "fast").map(check => (
              <p key={check.id} className="coding-plan-meta" data-plan-check={check.id}>Check: <code>{check.target}</code></p>
            ))}
            <p className="coding-plan-meta">Base HEAD <code className="coding-plan-sha" title={plan.base.commitId}>{plan.base.commitId}</code></p>
          </>
        ) : (
          <details className="coding-plan-fold">
            <summary>
              <span className="coding-plan-fold-title">Plan</span>
              <span className="coding-plan-meta">{atoms.length} {atoms.length === 1 ? "commit" : "commits"} · base <code className="coding-plan-sha" title={plan.base.commitId}>{plan.base.commitId}</code></span>
            </summary>
            <p className="coding-plan-intent">{change.intent}</p>
            <PlannedCommits card={card} atoms={atoms} />
            {change.checks.filter(check => check.tier === "fast").map(check => (
              <p key={check.id} className="coding-plan-meta" data-plan-check={check.id}>Check: <code>{check.target}</code></p>
            ))}
          </details>
        )
      ) : null}
      {planCard ? (
        card.status === "active" ? (
          <div className="coding-plan-door">
            {card.payload.error === undefined ? null : <p className="sui-approval-error" role="alert">{card.payload.error}</p>}
            <button type="button" className="coding-plan-start" data-flow="agent.change.start" onClick={() => onRunCommand("agent.change.start", card.id)}>Start the change</button>
          </div>
        ) : (
          <div className="coding-plan-door" data-testid={`coding-plan-started-${card.id}`}>
            <p className="coding-plan-started">
              <span className="run-outcome-dot" data-status="completed" aria-hidden />
              <span>{started === undefined ? "Started." : <>Started as run <code>{started.runId}</code>.</>}</span>
            </p>
            {started?.cardId === undefined ? null : (
              <button type="button" className="run-trace-filter" data-flow="card.maximize" onClick={() => onRunCommand("card.maximize", started.cardId)}>
                Expand run
              </button>
            )}
          </div>
        )
      ) : null}
      {tutorial ? null : (
        <>
          <h4>Predicted Changes</h4>
          <ol className="coding-plan-changes" aria-label="Predicted Changes">
            {plan.changes.map((entry, index) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="coding-plan-change"
                  data-flow="runs.coding.select"
                  aria-expanded={selected?.id === entry.id}
                  aria-controls={detailsId}
                  onClick={() => onRunCommand("runs.coding.select", `${card.payload.runId} ${entry.id}`)}
                >
                  <span className="coding-plan-number">{index + 1}</span>
                  <span>
                    <strong>{entry.title}</strong>
                    <span className="coding-plan-meta">
                      {entry.atoms.length} atomic {entry.atoms.length === 1 ? "change" : "changes"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {selected === undefined ?
            null :
            (
              <section id={detailsId} className="coding-plan-detail" aria-label={selected.title}>
                <h4>{selected.title}</h4>
                <p>{selected.intent}</p>
                <ol className="coding-plan-atoms" aria-label="Predicted atomic changes">
                  {selected.atoms.map((atom, index) => (
                    <li key={index}>
                      <strong>{atom.message}</strong>
                      <p>{atom.intent}</p>
                      <p className="coding-plan-meta">
                        {atom.changeId === null ? "New JJ change" : (
                          <>
                            Existing JJ change <code>{atom.changeId}</code>
                          </>
                        )}
                      </p>
                      <div className="coding-plan-paths">
                        <Paths label="Predicted reads" paths={atom.reads} />
                        <Paths label="Predicted writes" paths={atom.writes} />
                      </div>
                    </li>
                  ))}
                </ol>
                <h5>Planned checks</h5>
                <ul className="coding-plan-checks">
                  {selected.checks.map((check) => (
                    <li key={check.id}>
                      <span>{check.target}</span>
                      <span className="coding-plan-meta">{check.tier} · {check.required ? "required" : "optional"}</span>
                    </li>
                  ))}
                </ul>
                <details>
                  <summary>Plan context</summary>
                  <dl className="run-trace-kv">
                    <dt>Memory revision</dt>
                    <dd>
                      <code>{plan.memoryRevision}</code>
                    </dd>
                    <dt>Base JJ change</dt>
                    <dd>
                      <code>{plan.base.changeId}</code>
                    </dd>
                    <dt>Base commit</dt>
                    <dd>
                      <code>{plan.base.commitId}</code>
                    </dd>
                    <dt>Base tree</dt>
                    <dd>
                      <code>{plan.base.treeId}</code>
                    </dd>
                    <dt>Native operation</dt>
                    <dd>
                      <code>{plan.base.operationId}</code>
                    </dd>
                  </dl>
                </details>
              </section>
            )}
        </>
      )}
      {receipt ? <ChangeCommitStrip receipt={receipt} /> : null}
    </section>
  )
}

/** The commits the plan intends, in order. The practice plan tags each one (optional / required / recommended); a real plan carries none. */
const PlannedCommits = ({ card, atoms }: { readonly card: RunCard; readonly atoms: ReadonlyArray<{ readonly message: string; readonly writes: ReadonlyArray<string> }> }) => {
  const tags = card.payload.input?.atomTags as ReadonlyArray<string> | undefined
  return (
    <ol className="coding-plan-commits" aria-label="Planned commits">
      {atoms.map((atom, index) => {
        const tag = tags?.[index]
        return (
          <li key={index} data-planned-commit={index + 1} data-tag={tag}>
            <span className="coding-plan-number">{index + 1}</span>
            <span className="coding-plan-commit">
              <strong>{atom.message}</strong>
              {tag !== undefined ? <span className="coding-plan-tag"> {tag}</span> : null}
              {atom.writes.length > 0 ? <span className="coding-plan-meta"> · {atom.writes.join(", ")}</span> : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

const Paths = ({ label, paths }: { readonly label: string; readonly paths: ReadonlyArray<string> }) => (
  <div>
    <h5>{label}</h5>
    {paths.length === 0 ?
      <p className="coding-plan-meta">None declared</p> :
      (
        <ul>
          {paths.map((path) => (
            <li key={path}>
              <code>{path}</code>
            </li>
          ))}
        </ul>
      )}
  </div>
)
