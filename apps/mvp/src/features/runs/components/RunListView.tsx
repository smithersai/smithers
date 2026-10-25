import { EmptyState, RunList } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { NO_RUNS } from "../contract"
import { listLoaded, listRows } from "../page"
import { RunDetailsView } from "./RunDetailsView"
import { useRuns } from "./RunsContext"
import { routerLink } from "./routerLink"

// Every run on this device and the runs on Cloudflare this person may read, newest first, like a CI system's runs
// (decision 0014 §5, ruling FLOW-13): each with what started it, its branch and who started it, opening its run page,
// and opening in place to its jobs and steps with their logs. Until both lists have answered, none shows nothing.
export function RunListView({ flow, open }: { readonly flow?: string | undefined; readonly open?: string | undefined }) {
  const { queries } = useRuns()
  const { data: runs } = useLiveQuery(queries.runs)
  const { data: cloud } = useLiveQuery(queries.cloudRuns)
  const { data: view } = useLiveQuery(queries.view)
  const rows = listRows(runs ?? [], cloud ?? [], { ...(flow === undefined ? {} : { flow }), ...(open === undefined ? {} : { open }) })
  // Until this device's list and the runs on Cloudflare have answered, none says nothing.
  if (rows.length === 0 && !listLoaded(view)) return null
  return (
    <RunList
      runs={rows}
      now={Date.now()}
      renderLink={routerLink}
      renderDetails={() => <RunDetailsView />}
      empty={<EmptyState title={NO_RUNS} />}
    />
  )
}
