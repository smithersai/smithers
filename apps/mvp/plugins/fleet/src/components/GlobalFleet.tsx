import { EmptyState, RelativeTime, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useClock } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import { accountRowsOf, ALL, filterSessions, harnessesOf, hostRowsOf, rowsOf, sectionOf, sessionRowsOf, summaryOfGlobal } from "../GlobalFleetModel"
import type { FleetTab, Watched } from "../tab"
import "./fleet.css"
import { Pill } from "./parts"

function useWatched<A>(watched: Watched<A>): A {
  return useSyncExternalStore(watched.subscribe, watched.current, watched.current)
}

export function GlobalFleet({ tab }: { readonly tab?: FleetTab }) {
  if (tab === undefined) return <EmptyState title="Fleet unavailable" />
  return <Shown tab={tab} />
}

const HOST_WORDS = { loading: "Loading hosts", unavailable: "Hosts unavailable", empty: "No hosts connected" }
const ACCOUNT_WORDS = { loading: "Loading accounts", unavailable: "Accounts unavailable", empty: "No accounts reported" }
const SESSION_WORDS = { loading: "Loading sessions", unavailable: "Sessions unavailable", empty: "No active sessions" }

function Shown({ tab }: { readonly tab: FleetTab }) {
  const nodes = useWatched(tab.queries.globalNodes())
  const sessions = useWatched(tab.queries.globalSessions())
  const accounts = useWatched(tab.queries.globalAccounts())
  const filters = useWatched(tab.queries.filters)
  const now = useClock(true, 10_000)

  // Each part draws counts and "none" only from a delivered snapshot: loading or withheld rows are not an empty fleet.
  const hosts = sectionOf(nodes, HOST_WORDS, (rows) => hostRowsOf(rows, now))
  const active = sectionOf(sessions, SESSION_WORDS, (rows) => sessionRowsOf(rows, now, false))
  const accountsShown = sectionOf(accounts, ACCOUNT_WORDS, accountRowsOf)
  const summary = summaryOfGlobal(hosts, active, accountsShown)
  const hostRows = rowsOf(hosts)
  const accountRows = rowsOf(accountsShown)
  const allSessions = rowsOf(active)
  const filteredSessions = filterSessions(allSessions, filters)

  return (
    <div className="fleet" data-global-fleet="">
      {summary === undefined ? <p className="fleet-summary" aria-label="Fleet summary" data-pending="">Fleet counts unavailable</p> : (
        <p className="fleet-summary" aria-label="Fleet summary">
          <span>hosts {summary.onlineHosts}/{summary.totalHosts}</span>
          <span>{summary.activeSessions} active sessions</span>
          {summary.harnesses.map((each) => <span key={each.harness} data-harness={each.harness}>{each.harness} {each.sessions}</span>)}
          <span>accounts {summary.readyAccounts}/{summary.totalAccounts} ready</span>
          {summary.alertsCount > 0 ? <Pill tone="bad">{summary.alertsCount} alerts</Pill> : null}
        </p>
      )}

      <h2>Hosts</h2>
      {hosts._tag !== "Rows" ? <EmptyState title={hosts.title} /> : (
        <Table className="fleet-machines" aria-label="Hosts">
          <TableHeader>
            <TableRow>
              <TableHead>Host</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Sessions</TableHead>
              <TableHead className="fleet-wide">Load</TableHead>
              <TableHead className="fleet-wide">Memory</TableHead>
              <TableHead className="fleet-wide">Disk</TableHead>
              <TableHead className="fleet-wide">Seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hostRows.map((h) => (
              <TableRow key={h.nodeId} data-node={h.nodeId}>
                <TableCell>{h.name}</TableCell>
                <TableCell>{h.kind}</TableCell>
                <TableCell><Pill tone={h.tone}>{h.stateWord}</Pill></TableCell>
                <TableCell className="fleet-number">{h.activeSessions}</TableCell>
                <TableCell className="fleet-wide fleet-number">{h.load}</TableCell>
                <TableCell className="fleet-wide fleet-number">{h.memory}</TableCell>
                <TableCell className="fleet-wide fleet-number">{h.disk}</TableCell>
                <TableCell className="fleet-wide fleet-number">
                  {h.seenMs === null ? "-" : <RelativeTime ts={h.seenMs} />}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <h2>Accounts</h2>
      {accountsShown._tag !== "Rows" ? <EmptyState title={accountsShown.title} /> : (
        <Table className="fleet-accounts" aria-label="Accounts">
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>5h</TableHead>
              <TableHead>Weekly</TableHead>
              <TableHead className="fleet-wide">Scoped</TableHead>
              <TableHead className="fleet-wide">Resets</TableHead>
              <TableHead className="fleet-wide">Credits</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accountRows.map((a) => (
              <TableRow key={a.accountKey} data-account={a.accountKey}>
                <TableCell>{a.provider}</TableCell>
                <TableCell>{a.label}</TableCell>
                <TableCell>{a.plan}</TableCell>
                <TableCell className="fleet-number">{a.fiveHour}</TableCell>
                <TableCell className="fleet-number">{a.weekly}</TableCell>
                <TableCell className="fleet-wide fleet-number">{a.scoped}</TableCell>
                <TableCell className="fleet-wide fleet-number">
                  {a.resetsMs === null ? "-" : <RelativeTime ts={a.resetsMs} />}
                </TableCell>
                <TableCell className="fleet-wide fleet-number">{a.credits}</TableCell>
                <TableCell className="fleet-number">{a.activeSessions}</TableCell>
                <TableCell><Pill tone={a.tone}>{a.statusWord}</Pill></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <h2>Sessions</h2>
      <div className="fleet-summary" role="group" aria-label="Session filters">
        <label>
          Host{" "}
          <select value={filters.host} onChange={(e) => tab.actions.filterHost(e.target.value)}>
            <option value={ALL}>All hosts</option>
            {hostRows.map((h) => <option key={h.nodeId} value={h.nodeId}>{h.name}</option>)}
          </select>
        </label>
        <label>
          Harness{" "}
          <select value={filters.harness} onChange={(e) => tab.actions.filterHarness(e.target.value)}>
            <option value={ALL}>All</option>
            {harnessesOf(allSessions).map((each) => <option key={each.harness} value={each.harness}>{each.harness}</option>)}
          </select>
        </label>
      </div>
      {active._tag === "Pending" ? <EmptyState title={active.title} /> : filteredSessions.length === 0 ? <EmptyState title={SESSION_WORDS.empty} /> : (
        <Table className="fleet-runs" aria-label="Active sessions">
          <TableHeader>
            <TableRow>
              <TableHead>Host</TableHead>
              <TableHead>Harness</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="fleet-wide">Model</TableHead>
              <TableHead className="fleet-wide">Lane / Repo</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead className="fleet-wide">Time</TableHead>
              <TableHead className="fleet-wide">Activity</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredSessions.map((s) => (
              <TableRow key={s.sessionKey} data-session={s.sessionKey}>
                <TableCell>{s.nodeId}</TableCell>
                <TableCell>{s.harness}</TableCell>
                <TableCell>{s.account}</TableCell>
                <TableCell className="fleet-wide">{s.model}</TableCell>
                <TableCell className="fleet-wide">{s.repoOrLane}</TableCell>
                <TableCell className="fleet-label">{s.title}</TableCell>
                <TableCell className="fleet-wide fleet-number">{s.duration}</TableCell>
                <TableCell className="fleet-wide fleet-number">
                  {s.lastMs === null ? "-" : <RelativeTime ts={s.lastMs} />}
                </TableCell>
                <TableCell><Pill tone={s.tone}>{s.statusWord}</Pill></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
