import type { Host } from "@smthrs/plugin"
import {
  EmptyState,
  RelativeTime,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useClock,
} from "@smthrs/ui"
import { machinesOf, runsOf, summaryOf } from "../model"
import { Pill, useWatched, type ViewProps } from "./parts"
import "./fleet.css"

// The fleet (FINAL.md §4.1): one line of counts, every agent run of the repository (live ones first), then its runner
// machines. A run's TODO links to its page, where its transcript shows. Durations tick every 10 s on this tab's clock;
// how long ago a run last spoke ticks on @smthrs/ui's shared `RelativeTime`.
export function Fleet({ tab, repository }: ViewProps) {
  if (repository === undefined) return null
  return <Shown tab={tab} repository={repository} />
}

const plural = (count: number, word: string) => `${count} ${word}`

function Shown({ tab, repository }: Required<ViewProps> & { readonly repository: Host.Repository }) {
  const runs = useWatched(tab.queries.runs(repository))
  const machines = useWatched(tab.queries.machines(repository))
  const now = useClock(true, 10_000)
  const runRows = runs._tag === "Ready" ? runs.rows : []
  const machineRows = machinesOf(machines._tag === "Ready" ? machines.rows : [], runRows, now)
  const summary = summaryOf(runRows, machineRows, now)
  const rows = runsOf(runRows, now)
  const base = `/${repository.owner}/${repository.name}`
  return (
    <div className="fleet" data-loading={runs._tag === "Loading" ? "" : undefined}>
      <p className="fleet-summary" aria-label="Summary">
        <span data-count="working">{plural(summary.working, "working")}</span>
        <span data-count="waiting">{plural(summary.waiting, "waiting")}</span>
        <span data-count="stalled">{plural(summary.stalled, "stalled")}</span>
        <span data-count="failed">{plural(summary.failedToday, "failed today")}</span>
        <span data-count="runners">runners {summary.online}/{summary.machines}</span>
      </p>
      {runs._tag === "Ready" && rows.length === 0 ? <EmptyState title="No agent runs" /> : (
        <Table className="fleet-runs" aria-label="Agent runs">
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead className="fleet-wide">Runner</TableHead>
              <TableHead className="fleet-wide">Account</TableHead>
              <TableHead>Time</TableHead>
              <TableHead className="fleet-wide">Last event</TableHead>
              <TableHead className="fleet-wide">Usage</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key} data-run={row.key} data-state={row.state} data-number={row.number ?? undefined}>
                <TableCell className="fleet-label">
                  {row.number === null ? row.label : <a href={`${base}/stack/${row.number}`}>{row.label}</a>}
                </TableCell>
                <TableCell>{row.agent}</TableCell>
                <TableCell className="fleet-wide">{row.runner ?? "-"}</TableCell>
                <TableCell className="fleet-wide">{row.account ?? "-"}</TableCell>
                <TableCell className="fleet-number">{row.duration}</TableCell>
                <TableCell className="fleet-wide fleet-number">
                  {row.lastEventMs === null ? "-" : <RelativeTime ts={row.lastEventMs} />}
                </TableCell>
                <TableCell className="fleet-wide fleet-number">{row.usage}</TableCell>
                <TableCell>
                  <Pill tone={row.tone}>{row.reason === null ? row.word : `${row.word} · ${row.reason}`}</Pill>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {machines._tag !== "Ready" || machineRows.length === 0 ? null : (
        <Table className="fleet-machines" aria-label="Machines">
          <TableHeader>
            <TableRow>
              <TableHead>Machine</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Jobs</TableHead>
              <TableHead className="fleet-wide">Load</TableHead>
              <TableHead className="fleet-wide">Disk</TableHead>
              <TableHead className="fleet-wide">Version</TableHead>
              <TableHead className="fleet-wide">Seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {machineRows.map((machine) => (
              <TableRow key={machine.id} data-machine={machine.name} data-state={machine.state}>
                <TableCell>{machine.name}</TableCell>
                <TableCell><Pill tone={machine.tone}>{machine.word}</Pill></TableCell>
                <TableCell className="fleet-number">{machine.running}/{machine.capacity}</TableCell>
                <TableCell className="fleet-wide fleet-number">{machine.load ?? "-"}</TableCell>
                <TableCell className="fleet-wide fleet-number">{machine.disk ?? "-"}</TableCell>
                <TableCell className="fleet-wide">{machine.version ?? "-"}</TableCell>
                <TableCell className="fleet-wide fleet-number">
                  {machine.seenMs === null ? "-" : <RelativeTime ts={machine.seenMs} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
