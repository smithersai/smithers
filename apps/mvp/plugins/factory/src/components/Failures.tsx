import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui"
import { failuresOf } from "../model"
import { Frame } from "./Frame"
import { Pill, Section, type ViewProps } from "./parts"

// Failures: open and resolved, by kind, and each one with what failed, why, and what happened next.
export function Failures({ tab, repository }: ViewProps) {
  return (
    <Frame tab={tab} repository={repository} view="factory/failures">
      {(status) => {
        const failures = failuresOf(status)
        return (
          <Section title="Failures" wide>
            <p className="factory-big">{failures.open} open · {failures.resolved} resolved</p>
            <p className="factory-muted">{failures.kinds.map(({ kind, count }) => `${count} ${kind}`).join(" · ")}</p>
            <Table aria-label="Failures">
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Why</TableHead>
                  <TableHead className="factory-work">Next</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {failures.rows.map((failure, index) => (
                  <TableRow key={index}>
                    <TableCell className="factory-mono">{failure.at.slice(11, 16)}</TableCell>
                    <TableCell>
                      <Pill tone={failure.tone}>{failure.resolved ? "resolved" : "open"}</Pill> <b>{failure.what}</b>
                      <div className="factory-muted">{failure.kind}</div>
                    </TableCell>
                    <TableCell>{failure.why}</TableCell>
                    <TableCell className="factory-muted factory-work">{failure.next}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        )
      }}
    </Frame>
  )
}
