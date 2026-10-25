import { Badge, Button, Card, EmptyState, LoadingBar } from "@smthrs/ui"
import { TerminalFrame } from "@smthrs/terminal-frame"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useParams } from "@tanstack/react-router"
import { useShownMode } from "../../theme/components/ThemeButton"
import { OPEN_TERMINAL, panelViewOf, WAITING_FOR_SANDBOX } from "../view"
import { useTerminal } from "./TerminalContext"

// The branch's terminal (decision 0013 §3, §5): our xterm in an opaque-origin frame, attached to a shell on the
// branch's machine, typing for anyone who may edit the branch and read-only for anyone who may only view it. Its tabs
// are the branch's live terminals, by owner. The screen, the terminal's place on the page, is always there: the
// terminal, Open terminal in its middle (with a calm bar along its top while the machine wakes), or `No terminals`
// (`../view.ts`).
export function TerminalPanel({ canOpen }: { readonly canOpen: boolean }) {
  const { queries, actions } = useTerminal()
  const mode = useShownMode()
  const params = useParams({ strict: false })
  const { data: panel } = useLiveQuery(queries.panel)
  const { data: tabs } = useLiveQuery(queries.tabs)
  const view = panelViewOf(panel, tabs, canOpen)
  if (panel === undefined || view === undefined) return null
  const routeParams = { owner: params.owner ?? "", repo: params.repo ?? "", ref: params.ref ?? "", _splat: params._splat ?? "" }
  const openButton = view.open === undefined ? null : (
    <span className="terminal-panel-open">
      <Button onClick={actions.open} disabled={view.open !== "button"}>
        {OPEN_TERMINAL}
      </Button>
      {view.open === "button" ? null : <LoadingBar loading placement="inline" />}
      {view.open === "waiting" ? <span role="status">{WAITING_FOR_SANDBOX}</span> : null}
    </span>
  )
  const { screen } = view
  return (
    <section className="terminal-panel" aria-label="Terminal" data-phase={panel.phase}>
      {tabs.length === 0 && view.badge === undefined && screen.kind !== "frame" ? null : (
      <div className="terminal-panel-bar">
        {tabs.length > 0 ? (
          <nav className="terminal-panel-tabs" aria-label="Terminals">
            {tabs.map((tab) => (
              <Link
                key={tab.id}
                to="/$owner/$repo/tree/$ref/$"
                params={routeParams}
                search={{ terminal: tab.mine ? "me" : tab.id }}
                aria-current={tab.id === panel.terminalId ? "page" : undefined}
              >
                {tab.ownerLogin}
              </Link>
            ))}
          </nav>
        ) : null}
        {view.badge === undefined ? null : <Badge variant={view.badge === "No access" ? "destructive" : "muted"}>{view.badge}</Badge>}
        {screen.kind === "frame" ? openButton : null}
      </div>
      )}
      <Card className="terminal-panel-screen" data-screen={screen.kind}>
        {screen.kind === "frame" ? (
          <TerminalFrame
            key={screen.terminalId}
            className="terminal-panel-frame"
            title="Terminal"
            theme={mode}
            readOnly={screen.readOnly}
            stream={(write) => actions.attach(screen.terminalId, write)}
            onInput={actions.input}
            onResize={actions.resize}
          />
        ) : screen.kind === "open" ? openButton : screen.text === undefined ? null : <EmptyState title={screen.text} />}
      </Card>
    </section>
  )
}
