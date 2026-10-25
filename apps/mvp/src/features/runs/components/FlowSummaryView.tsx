import { stepDuration, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { cloudRowOf, listHref } from "../page"
import { flowSummary } from "../summary"
import { useRuns } from "./RunsContext"
import { routerLink } from "./routerLink"

// The Runs page's flows (docs/features/runs.md#flows): runs, success and p95 per flow, this device's and Cloudflare's.
// Each flow lists its own runs, as a CI system's workflows do; All lists every run again.
export function FlowSummaryView({ flow }: { readonly flow?: string | undefined }) {
  const { queries } = useRuns()
  const { data: runs } = useLiveQuery(queries.runs)
  const { data: cloud } = useLiveQuery(queries.cloudRuns)
  const rows = flowSummary([...(runs ?? []), ...(cloud ?? []).map(cloudRowOf)])
  if (rows.length === 0) return null
  return (
    <Table aria-label="Flows">
      <TableHeader>
        <TableRow>
          <TableHead>Flow</TableHead>
          <TableHead>Runs</TableHead>
          <TableHead>Success</TableHead>
          <TableHead>p95</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {flow === undefined ? null : (
          <TableRow>
            <TableCell colSpan={4}>{routerLink(listHref({}), "All")}</TableCell>
          </TableRow>
        )}
        {rows.map((row) => (
          <TableRow key={row.flow} aria-current={row.flow === flow ? "true" : undefined}>
            <TableCell>{routerLink(listHref({ flow: row.flow }), row.flow)}</TableCell>
            <TableCell>{row.runs}</TableCell>
            <TableCell>{row.successRate === null ? "–" : `${Math.round(row.successRate * 100)}%`}</TableCell>
            <TableCell>{row.p95Ms === null ? "–" : stepDuration(row.p95Ms)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
