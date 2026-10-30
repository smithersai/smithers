import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui"
import { implementationOf } from "../model"
import { Frame } from "./Frame"
import { Lanes } from "./Lanes"
import { Section, type ViewProps } from "./parts"

// Implementation: the VIP constructs that don't match their Effect TS yet, the reviewers' verdicts (each opens its
// report), the implementation lanes and what landed on main.
export function Implementation({ tab, repository }: ViewProps) {
  return (
    <Frame tab={tab} repository={repository} view="factory/implementation">
      {(status, now) => {
        const implementation = implementationOf(status, now)
        return (
          <>
            <Section title="Pending constructs">
              <Table aria-label="Pending constructs">
                <TableBody>
                  {implementation.perVip.map((row) => (
                    <TableRow key={row.vip}>
                      <TableCell>{row.vip}</TableCell>
                      <TableCell className="factory-number">{row.pending}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Reviews">
              <Table aria-label="Reviews">
                <TableBody>
                  {implementation.reviews.map((review) => (
                    <TableRow key={review.who}>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          data-tone={review.tone}
                          onClick={() => tab.actions.read(repository!, "report", review.report, review.who)}
                        >
                          {review.grade || "?"}
                        </Button>{" "}
                        {review.who}
                      </TableCell>
                      <TableCell className="factory-muted factory-work">{review.line}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Lanes" wide>
              <Lanes tab={tab} repository={repository!} lanes={implementation.lanes} />
            </Section>
            <Section title="Landed" wide>
              <Table aria-label="Landed">
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Lane</TableHead>
                    <TableHead>Commit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {implementation.landed.map((entry, index) => (
                    <TableRow key={index}>
                      <TableCell className="factory-mono">{entry.at.slice(11, 16)}</TableCell>
                      <TableCell><b>{entry.lane}</b></TableCell>
                      <TableCell className="factory-mono">{entry.commit}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
          </>
        )
      }}
    </Frame>
  )
}
