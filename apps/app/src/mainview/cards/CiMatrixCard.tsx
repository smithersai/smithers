/*
 * The CI matrix card (docs/LOCAL-APP.md "Cards: target graph"): the GitHub
 * Actions pipelines the graph implies (jobs, their targets, and the shard
 * fan-out) with the generated YAML in a collapsible monospace block per
 * pipeline. Product copy says "pipeline", never "workflow"; the GitHub file
 * keeps its own name.
 */
import { Badge, EmptyState } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"

export const CiMatrixCardBody = ({ card }: { readonly card: Extract<Card, { kind: "ci-matrix" }> }) => {
  const { repoId, status, result, error } = card.payload
  if (status === "pending") return <p className="smithers-card-note">Generating the CI matrix…</p>
  if (status === "failed" || result === undefined) {
    return (
      <p className="sui-approval-error" role="alert">
        {error ?? "The CI matrix did not load."}
      </p>
    )
  }
  if (result.workflows.length === 0) return <EmptyState description="The graph implies no CI pipelines." />
  return (
    <div className="ci-matrix-card" data-testid={`ci-matrix-card-${repoId}`}>
      {result.workflows.map((workflow) => (
        <section key={workflow.path} className="ci-matrix-workflow" data-workflow={workflow.name}>
          <h3 className="ci-matrix-workflow-name">
            pipeline {workflow.name} <code className="graph-drawer-mono">{workflow.path}</code>
          </h3>
          <table className="ci-matrix-jobs" aria-label="CI jobs">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Targets</th>
                <th scope="col">Matrix</th>
              </tr>
            </thead>
            <tbody>
              {workflow.jobs.map((job) => (
                <tr key={job.name} data-job-row={job.name}>
                  <td>{job.name}</td>
                  <td>
                    {job.targets.map((target) => (
                      <code key={target} className="graph-drawer-mono ci-matrix-target">{target}</code>
                    ))}
                  </td>
                  <td>
                    {Object.entries(job.matrix ?? {}).map(([axis, values]) => (
                      <Badge key={axis} variant="outline">
                        {axis}: {values.join(", ")}
                      </Badge>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className="ci-matrix-yaml">
            <summary>YAML</summary>
            <pre className="graph-drawer-mono">{workflow.yaml}</pre>
          </details>
        </section>
      ))}
    </div>
  )
}

export const ciMatrixCardFamily: CardFamily<"ci-matrix"> = {
  "ci-matrix": { render: (card) => <CiMatrixCardBody card={card} />, pill: (card) => card.payload.status }
}
