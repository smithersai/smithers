import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useClock } from "@smthrs/ui"
import { lanesOf, runLanesOf } from "../model"
import { Frame } from "./Frame"
import { Lanes } from "./Lanes"
import { Pill, Section, useWatched, type ViewProps } from "./parts"

// Agents: the repository's agent runs on Smithers itself (`core/agent-runs`, the fleet's query), each linking to its
// TODO; then every collector lane, newest first, each opening its live transcript; then the collector's daemons and,
// for a maintainer, the accounts.
export function Agents({ tab, repository }: ViewProps) {
  if (repository === undefined) return null
  return <AgentsOn tab={tab} repository={repository} />
}

function AgentsOn({ tab, repository }: Required<ViewProps>) {
  const runs = useWatched(tab.queries.runs(repository!))
  const now = useClock(runs.length > 0, 10_000)
  const lanes = runLanesOf(runs, now)
  const base = `/${repository!.owner}/${repository!.name}`
  return (
    <Frame tab={tab} repository={repository} view="factory/agents">
      {(status, at) => (
        <>
          {lanes.length === 0 ? null : (
            <Section title="On Smithers" wide>
              <Table className="factory-lanes" aria-label="Runs on Smithers">
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead className="factory-work">Work</TableHead>
                    <TableHead>Machine</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lanes.map((lane) => (
                    <TableRow key={lane.key} data-run={lane.key} data-state={lane.state}>
                      <TableCell>
                        {lane.number === null ? lane.name : <a href={`${base}/stack/${lane.number}`}>{lane.name}</a>}
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
            </Section>
          )}
          <Section title="Lanes" wide>
            <Lanes tab={tab} repository={repository!} lanes={lanesOf(status.agents, at)} />
          </Section>
          <Section title="Daemons">
            <ul className="factory-list">
              {status.daemons.map((daemon) => (
                <li key={daemon.name}>
                  <Pill tone={daemon.running ? "ok" : "bad"}>{daemon.running ? "running" : "stopped"}</Pill> {daemon.name}
                </li>
              ))}
            </ul>
          </Section>
          {status.accounts === null ? null : (
            <Section title="Accounts">
              {status.accounts.map((account) => (
                <div key={account.pool} className="factory-mono">
                  <b>{account.pool}</b>
                  {account.lines.map((line, index) => <div key={index}>{line}</div>)}
                </div>
              ))}
            </Section>
          )}
        </>
      )}
    </Frame>
  )
}
