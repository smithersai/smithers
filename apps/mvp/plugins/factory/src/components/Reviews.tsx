import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui"
import { ORIGINS, REVIEWERS, reviewsOf } from "../model"
import { Frame } from "./Frame"
import { Pill, Section, type ViewProps } from "./parts"

// Spec reviews: every round's four grades, each opening its report, or the reviewer still at work; the round events;
// and every finding labeled by where it came from, to see whether the rounds converge.
export function Reviews({ tab, repository }: ViewProps) {
  return (
    <Frame tab={tab} repository={repository} view="factory/reviews">
      {(status, now) => {
        const reviews = reviewsOf(status, now)
        return (
          <>
            <Section title="Rounds" wide>
              <Table aria-label="Rounds">
                <TableHeader>
                  <TableRow>
                    <TableHead>Round</TableHead>
                    {REVIEWERS.map((who) => <TableHead key={who}>{who}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reviews.rounds.map(({ round, cells }) => (
                    <TableRow key={round}>
                      <TableCell><b>{round}</b></TableCell>
                      {cells.map((cell, index) => (
                        <TableCell key={index}>
                          {cell._tag === "Graded"
                            ? (
                              <Button
                                variant="outline"
                                size="sm"
                                data-tone={cell.grade.tone}
                                onClick={() => tab.actions.read(repository!, "report", cell.grade.report, `Round ${round} · ${cell.grade.who}`)}
                              >
                                {cell.grade.grade}
                              </Button>
                            )
                            : cell._tag === "Working"
                            ? (
                              <Button
                                variant="link"
                                onClick={() => tab.actions.read(repository!, "transcript", `transcript/${cell.lane}`, cell.lane)}
                              >
                                <Pill tone={cell.state === "running" ? "run" : "muted"}>
                                  {cell.state === "running" ? cell.duration : cell.state}
                                </Pill>
                              </Button>
                            )
                            : "–"}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Events">
              <ul className="factory-feed">{reviews.events.map((event, index) => <li key={index}>{event}</li>)}</ul>
            </Section>
            <Section title="Findings" wide>
              <Table aria-label="Findings by origin">
                <TableHeader>
                  <TableRow>
                    <TableHead>Round</TableHead>
                    <TableHead>All</TableHead>
                    {ORIGINS.map((origin) => <TableHead key={origin.origin}><Pill tone={origin.tone}>{origin.label}</Pill></TableHead>)}
                    <TableHead><Pill tone="bad">lego</Pill></TableHead>
                    <TableHead><Pill tone="bad">circles</Pill></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reviews.origins.map((row) => (
                    <TableRow key={row.round}>
                      <TableCell><b>{row.round}</b></TableCell>
                      <TableCell>{row.total}</TableCell>
                      {row.byOrigin.map((n, index) => <TableCell key={index}>{n}</TableCell>)}
                      <TableCell>{row.lego}</TableCell>
                      <TableCell>{row.circles}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {reviews.findings.map(({ round, findings }) => (
                <details key={round} className="factory-item">
                  <summary>Round {round} · {findings.length}</summary>
                  <ul className="factory-list">
                    {findings.map((finding, index) => (
                      <li key={index}>
                        <b>{finding.title}</b> <span className="factory-muted">{finding.severity} · {finding.origin}</span>
                        <div className="factory-muted">{finding.evidence}</div>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </Section>
          </>
        )
      }}
    </Frame>
  )
}
