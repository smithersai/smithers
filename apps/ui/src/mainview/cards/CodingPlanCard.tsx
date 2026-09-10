import { runSourceCommand } from "../flows/RunCommand"
import type { Card } from "../state/AppState"
import { codingEvidenceOf } from "./CodingPlan"
import type { RunCommand } from "./CardFamily"

/** Predicted ownership is visible before execution. Recorded receipts arrive through the run journal. */
export const CodingPlanBody = ({ card, onRunCommand: sendRunCommand }: {
  readonly card: Extract<Card, { kind: "run-trace" }>
  readonly onRunCommand: RunCommand
}) => {
  const onRunCommand = runSourceCommand(card.id, sendRunCommand)
  const { plan, outcome, blockedSpanId, reviewFeedback } = codingEvidenceOf(card)
  if (plan === undefined) return null
  const selected = plan.changes.find((change) => change.id === card.payload.codingChangeId)
  const reviewSummary = reviewFeedback?.result.findings[0]?.message ?? ""
  const detailsId = `${card.id}-coding-details`
  return (
    <section className="coding-plan" aria-label="Coding plan">
      {reviewFeedback === undefined ? null : (
        <div aria-label="Coding review feedback">
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
        <div aria-label="Coding outcome">
          <p>
            {outcome.status === "validated" ? "Validated" : outcome.status === "changes-requested" ? "Changes requested" : "Blocked"}
            {` after ${outcome.rounds} ${outcome.rounds === 1 ? "round" : "rounds"}.`}
          </p>
          {outcome.blocked === null ? null : <p>{outcome.blocked.message}</p>}
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
      <h4>Predicted Changes</h4>
      <ol className="coding-plan-changes" aria-label="Predicted Changes">
        {plan.changes.map((change, index) => (
          <li key={change.id}>
            <button
              type="button"
              className="coding-plan-change"
              data-flow="runs.coding.select"
              aria-expanded={selected?.id === change.id}
              aria-controls={detailsId}
              onClick={() => onRunCommand("runs.coding.select", `${card.payload.runId} ${change.id}`)}
            >
              <span className="coding-plan-number">{index + 1}</span>
              <span>
                <strong>{change.title}</strong>
                <span className="coding-plan-meta">
                  {change.atoms.length} atomic {change.atoms.length === 1 ? "change" : "changes"}
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
    </section>
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
