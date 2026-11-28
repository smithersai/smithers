import type { Host } from "@smthrs/plugin"
import { Badge, EmptyState, LoadingBar, Markdown, Skeleton, UphillScorecard } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import type { UphillTab, Watched } from "../tab"
import "./uphill.css"

const useWatched = <A,>(watched: Watched<A>): A => useSyncExternalStore(watched.subscribe, watched.current, watched.current)

export function Uphill({ tab, repository }: { readonly tab: UphillTab; readonly repository?: Host.Repository | undefined }) {
  if (repository === undefined) return <EmptyState title="Open a repository to view audit scores" />
  return <UphillBody tab={tab} repository={repository} />
}

function UphillBody({ tab, repository }: { readonly tab: UphillTab; readonly repository: Host.Repository }) {
  const state = useWatched(tab.queries.state(repository))
  if (state.status === "loading") {
    return (
      <div className="uphill-plugin-view uphill-plugin-loading" aria-busy="true">
        <LoadingBar loading placement="inline" label="Loading backpressure audit" />
        <Skeleton />
      </div>
    )
  }
  if (state.status === "refused") return <EmptyState title="Backpressure audit report not available" />
  const hasCommunitySection = state.untrustedRuns.length > 0 ||
    state.pendingPreviews.length > 0 ||
    state.failedPreviews.length > 0
  if (!state.hasFeed || (state.envelope === undefined && !hasCommunitySection)) {
    return (
      <EmptyState
        title="No backpressure audit published yet"
        description="Run uphill and publish via the audit_report_publish MCP tool or push to the uphill feed."
      />
    )
  }

  return (
    <div className="uphill-plugin-view" aria-label="Repository backpressure audit scorecard">
      {state.envelope !== undefined ? (
        <>
          {state.loadingHistory ? (
            <div className="uphill-inline-progress" aria-busy="true">
              <LoadingBar loading placement="inline" label="Loading audit history" />
            </div>
          ) : null}
          {state.historyFailed ? (
            <div className="uphill-preview-error" role="status">
              <Badge variant="warning">History unavailable</Badge>
            </div>
          ) : null}
          <UphillScorecard
            report={state.envelope.report}
            commit={state.envelope.commit}
            branch={state.envelope.branch}
            history={state.history}
            provenance={state.envelope.provenance ?? {
              trust: "trusted_sandbox",
              gateEligible: true,
              cacheWriteAllowed: true,
              runner: "Smithers Cloud Sandbox",
            }}
            selectedCategory={state.selectedCategory}
            onSelectCategory={(category) => tab.actions.selectCategory(repository, category)}
          />
        </>
      ) : (
        <EmptyState
          title="No trusted baseline report yet"
          description="Only runs from controlled Smithers sandboxes or maintainers establish the trusted gate baseline."
        />
      )}

      {hasCommunitySection ? (
        <section className="uphill-untrusted-section" aria-label="Community untrusted audit runs">
          <div className="uphill-untrusted-head">
            <h3>Community runs (untrusted)</h3>
            <Badge variant="warning">Informational only</Badge>
            <Badge variant="muted">Cache isolated</Badge>
          </div>
          {state.pendingPreviews.length > 0 ? (
            <div className="uphill-inline-progress" aria-busy="true">
              <LoadingBar loading placement="inline" label="Loading community audit runs" />
              <Skeleton />
            </div>
          ) : null}
          {state.failedPreviews.length > 0 ? (
            <div className="uphill-preview-error" role="status">
              <Badge variant="destructive">
                {state.failedPreviews.length === 1
                  ? "1 community run unavailable"
                  : `${state.failedPreviews.length} community runs unavailable`}
              </Badge>
            </div>
          ) : null}
          {state.untrustedRuns.length > 0 ? (
            <div className="uphill-untrusted-list">
              {state.untrustedRuns.map((run) => (
                <article key={run.id} className="uphill-untrusted-card">
                  <div className="uphill-untrusted-meta">
                    <strong>@{run.actor}</strong>
                    <Badge variant={run.band === "good" ? "success" : run.band === "warn" ? "warning" : "muted"}>
                      {run.overall !== null ? `${run.overall}/100` : "unscored"}
                    </Badge>
                    {run.envelope.commit ? <Badge variant="muted">{run.envelope.commit.slice(0, 8)}</Badge> : null}
                  </div>
                  <UphillScorecard
                    report={run.envelope.report}
                    commit={run.envelope.commit}
                    branch={run.envelope.branch}
                    provenance={run.envelope.provenance ?? {
                      trust: "untrusted_contributor",
                      gateEligible: false,
                      cacheWriteAllowed: false,
                      actor: run.actor,
                      runner: `Community runner (${run.actor})`,
                    }}
                  />
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {state.envelope?.rules ? (
        <section className="uphill-plugin-rules" aria-label="Backpressure rules">
          <Markdown content={state.envelope.rules} />
        </section>
      ) : null}
    </div>
  )
}
