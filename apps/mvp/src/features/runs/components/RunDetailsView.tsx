import { LoadingBar, RunDetails, StepLogs } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { detailsOf } from "../details"
import { missingOf } from "../page"
import type { RunPage } from "../schema"
import { useRuns } from "./RunsContext"
import { useRepoVisible } from "../../repo/components/RepoGate"
import { runRepository } from "../repository"
import { routerLink } from "./routerLink"

// The run the Runs page shows opened in place: its jobs and steps, each step opening to its log lines, a failed one
// open with its error (ruling FLOW-13). Read and followed live like its page; every line is text the engine redacted.
export function RunDetailsView() {
  const { queries } = useRuns()
  const { data } = useLiveQuery(queries.expandedPage)
  const { data: cloud } = useLiveQuery(queries.cloudRuns)
  const visible = useRepoVisible()
  const page = data?.page as RunPage | undefined
  // A repository's run opens nothing while the repository may not show (`repoVisibility`).
  if (page !== undefined && !visible(runRepository(page.id, page, cloud))) return null
  const now = Date.now()
  if (page === undefined || page.state === "loading") return <LoadingBar loading placement="inline" label="Loading" />
  if (page.state !== "read") return <p className="sui-run-details-empty">{missingOf(page)}</p>
  const { jobs, logs } = detailsOf(page, now)
  return (
    <RunDetails
      jobs={jobs}
      now={now}
      renderLink={routerLink}
      renderLogs={(_, step) => <StepLogs className="runs-log" lines={logs.get(step.id) ?? []} now={now} />}
    />
  )
}
