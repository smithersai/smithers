import type { Host } from "@smthrs/plugin"
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui"
import type { Lane } from "../model"
import type { FactoryTab } from "../tab"
import { Pill } from "./parts"

// A list of lanes: name and phase, its work, the machine, the model and account, its state and how long it ran. A lane
// opens its live transcript beside the view.
export function Lanes(
  { tab, repository, lanes }: { readonly tab: FactoryTab; readonly repository: Host.Repository; readonly lanes: ReadonlyArray<Lane> },
) {
  if (lanes.length === 0) return <p className="factory-muted">None</p>
  return (
    <Table className="factory-lanes" aria-label="Lanes">
      <TableHeader>
        <TableRow>
          <TableHead>Lane</TableHead>
          <TableHead className="factory-work">Work</TableHead>
          <TableHead>Machine</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lanes.map((lane) => (
          <TableRow key={lane.name} data-lane={lane.name} data-state={lane.state}>
            <TableCell>
              <Button
                variant="link"
                className="factory-open"
                onClick={() => tab.actions.read(repository, "transcript", `transcript/${lane.name}`, lane.name)}
              >
                {lane.name}
              </Button>
              <div className="factory-muted">{lane.phase}</div>
            </TableCell>
            <TableCell className="factory-work">{lane.title}</TableCell>
            <TableCell>{lane.machine}</TableCell>
            <TableCell>
              {lane.model}
              <div className="factory-muted">{lane.account}</div>
            </TableCell>
            <TableCell><Pill tone={lane.tone}>{lane.label}</Pill></TableCell>
            <TableCell className="factory-number">{lane.duration}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
