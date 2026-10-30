import { Button, Progress, Table, TableBody, TableCell, TableRow } from "@smthrs/ui"
import { nowOf } from "../model"
import { Frame } from "./Frame"
import { Lanes } from "./Lanes"
import { Pill, Section, ViewLink, type ViewProps } from "./parts"

// Now: the scoreboard, the spec round and its grades, the implementation, main and the migrations, the lanes running,
// what waits on a maintainer, and the latest events.
export function Now({ tab, repository }: ViewProps) {
  return (
    <Frame tab={tab} repository={repository} view="factory/now">
      {(status, at) => {
        const now = nowOf(status, at)
        return (
          <>
            <Section title="Scoreboard" wide>
              <Table aria-label="Scoreboard">
                <TableBody>
                  {now.scoreboard.map((score) => (
                    <TableRow key={score.area} data-met={score.met}>
                      <TableCell><b>{score.area}</b></TableCell>
                      <TableCell className="factory-muted factory-work">{score.target}</TableCell>
                      <TableCell>{score.now}</TableCell>
                      <TableCell><Pill tone={score.met ? "ok" : "warn"}>{score.met ? "met" : "not yet"}</Pill></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Spec">
              <p>{now.spec.what}</p>
              {now.spec.round === null ? null : (
                <div className="factory-grades" aria-label={`Round ${now.spec.round}`}>
                  <span>Round {now.spec.round}</span>
                  {now.spec.grades.map((grade) => (
                    <Button
                      key={grade.who}
                      variant="outline"
                      size="sm"
                      data-tone={grade.tone}
                      aria-label={`${grade.who} ${grade.grade || "?"}`}
                      onClick={() => tab.actions.read(repository!, "report", grade.report, `Round ${now.spec.round} · ${grade.who}`)}
                    >
                      {grade.grade || "?"}
                    </Button>
                  ))}
                </div>
              )}
            </Section>
            <Section title="Implementation">
              <p className="factory-big">{now.implementation.total > 0 ? `${now.implementation.matched} / ${now.implementation.total}` : "–"}</p>
              <p className="factory-muted">{now.implementation.running.length} lanes · {now.implementation.running.join(" · ")}</p>
            </Section>
            <Section title="Main">
              <p><Pill tone={now.main.green ? "ok" : "bad"}>{now.main.green ? "GREEN" : "RED"}</Pill></p>
              {now.main.migrations.map((migration) => (
                <div key={migration.repo} className="factory-migration">
                  <span>{migration.repo} {migration.pass}/{migration.total}</span>
                  <Progress value={migration.percent} aria-label={migration.repo} />
                </div>
              ))}
            </Section>
            <Section title="Running" wide>
              {now.openFailures > 0
                ? (
                  <p>
                    <ViewLink tab={tab} repository={repository} view="factory/failures">{now.openFailures} open failures</ViewLink>
                  </p>
                )
                : null}
              <Lanes tab={tab} repository={repository!} lanes={now.lanes} />
            </Section>
            <Section title="For you">
              {now.waiting.length === 0
                ? <p className="factory-muted">Nothing waiting</p>
                : (
                  <ul className="factory-list">
                    {now.waiting.map((decision) => (
                      <li key={decision.id}>
                        <ViewLink tab={tab} repository={repository} view="factory/for-you">{decision.title}</ViewLink>{" "}
                        <Pill tone={decision.kind === "decide" ? "warn" : "run"}>{decision.kind}</Pill>
                      </li>
                    ))}
                  </ul>
                )}
            </Section>
            <Section title="Events" wide>
              <ul className="factory-feed">
                {now.events.map((event, index) => <li key={index}>{event}</li>)}
              </ul>
            </Section>
          </>
        )
      }}
    </Frame>
  )
}
