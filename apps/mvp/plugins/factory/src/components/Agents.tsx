import { lanesOf } from "../model"
import { Frame } from "./Frame"
import { Lanes } from "./Lanes"
import { Pill, Section, type ViewProps } from "./parts"

// Agents: every lane, newest first; a lane opens its live transcript. Then the collector's daemons and, for a
// maintainer, the accounts.
export function Agents({ tab, repository }: ViewProps) {
  return (
    <Frame tab={tab} repository={repository} view="factory/agents">
      {(status, now) => (
        <>
          <Section title="Lanes" wide>
            <Lanes tab={tab} repository={repository!} lanes={lanesOf(status.agents, now)} />
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
