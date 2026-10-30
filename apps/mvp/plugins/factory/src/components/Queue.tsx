import { Progress, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui"
import { queueOf } from "../model"
import { Frame } from "./Frame"
import { Pill, Section, type ViewProps } from "./parts"

// Queue: the merge queue, main after each merge, the resolver, the migrations, the build hosts and, for a maintainer,
// the Telegram thread.
export function Queue({ tab, repository }: ViewProps) {
  return (
    <Frame tab={tab} repository={repository} view="factory/queue">
      {(status) => {
        const queue = queueOf(status)
        return (
          <>
            <Section title="Merge queue" wide>
              <Table aria-label="Merge queue">
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Lane</TableHead>
                    <TableHead className="factory-work">Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.entries.map((entry, index) => (
                    <TableRow key={index}>
                      <TableCell className="factory-mono">{entry.at.slice(11, 16)}</TableCell>
                      <TableCell><Pill tone={entry.tone}>{entry.state}</Pill></TableCell>
                      <TableCell><b>{entry.lane}</b> <span className="factory-mono factory-muted">{entry.rev}</span></TableCell>
                      <TableCell className="factory-muted factory-work">{entry.detail}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
            <Section title="Main">
              <ul className="factory-list">
                {queue.main.map((run, index) => (
                  <li key={index}>
                    <Pill tone={run.green ? "ok" : "bad"}>{run.green ? "GREEN" : "RED"}</Pill>{" "}
                    <span className="factory-mono">{run.commit}</span> <span className="factory-muted">{run.at.slice(11, 16)}</span>
                    {run.why === "" ? null : <div className="factory-muted">{run.why}</div>}
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="Resolver">
              <ul className="factory-feed">{queue.resolver.map((line, index) => <li key={index}>{line}</li>)}</ul>
            </Section>
            <Section title="Migrations">
              {queue.migrations.map((migration) => (
                <div key={migration.repo} className="factory-migration">
                  <span>{migration.repo} {migration.pass}/{migration.total}</span>
                  <Progress value={migration.percent} aria-label={migration.repo} />
                </div>
              ))}
            </Section>
            <Section title="Hosts">
              <ul className="factory-list">
                {queue.hosts.map((host) => (
                  <li key={host.name}>
                    <b>{host.name}</b> · load {host.load} · <Pill tone={host.tone}>{host.disk === null ? "?" : `${host.disk}%`}</Pill>{" "}
                    <span className="factory-muted">{host.free}</span>
                  </li>
                ))}
              </ul>
            </Section>
            {queue.telegram === null ? null : (
              <Section title="Telegram" wide>
                <ul className="factory-feed">
                  {queue.telegram.map((message, index) => (
                    <li key={index} data-bot={message.bot}>
                      <span className="factory-muted">{message.bot ? "orchestrator" : "Will"}</span> {message.text}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )
      }}
    </Frame>
  )
}
