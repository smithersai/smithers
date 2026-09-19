import { Terminal } from "@smthrs/ui/adapters/terminal"
import { useRef } from "react"
import { useController } from "../ControllerContext"
import type { TabRow } from "../state/AppState"

/*
 * A terminal tab's body (docs/LOCAL-APP.md "Tabs"): the shipped `@smthrs/ui`
 * xterm adapter (@xterm/xterm + @xterm/addon-fit) attached to the tab's cloud
 * workspace session through the `/api/cloud-ws/` tunnel. A terminal is always
 * a workspace terminal: the local PTY retired with the local backend
 * (docs/LOCAL-BACKEND-RETIREMENT.md), so a tab without a workspace has no
 * process to show.
 *
 * xterm needs a DOM node to open into, and this package writes no lifecycle
 * effect for it: the adapter owns the mount and the fit addon, and this
 * component only hands it the three seams — the output stream (which
 * returns its own detach), the keystrokes, and the geometry. The tab body
 * that renders this stays mounted while hidden, so the emulator and its
 * scrollback live as long as the tab does.
 */
export function TerminalView({ tab }: { readonly tab: Extract<TabRow, { kind: "terminal" | "harness" }> }) {
  const controller = useController()
  const { sessionId } = tab
  const repo = tab.kind === "terminal" && tab.workspaceId !== undefined ? tab.repo : undefined
  /* The last geometry sent, so a refit that changed nothing sends nothing. */
  const lastGeometry = useRef("")
  if (repo === undefined) {
    return (
      <div className="tab-terminal" data-testid={`terminal-${sessionId}`}>
        This terminal session is no longer available.
      </div>
    )
  }
  return (
    <Terminal
      className="tab-terminal"
      data-testid={`terminal-${sessionId}`}
      /* Control focus (state/controller/controlFocus.ts): the xterm helper textarea's focusin finds this marker. */
      data-control-focus-id={`terminal:${sessionId}`}
      data-control-focus-kind="terminal"
      stream={(write) => controller.cloudTerminal.attach(repo, sessionId, { onOutput: write })}
      onData={(data) => controller.cloudTerminal.input(sessionId, data)}
      onResize={({ cols, rows }) => {
        // The adapter refits on every host resize; only a changed geometry reaches the server.
        const geometry = `${cols}x${rows}`
        if (geometry === lastGeometry.current || cols === 0 || rows === 0) return
        lastGeometry.current = geometry
        controller.cloudTerminal.resize(sessionId, cols, rows)
      }}
    />
  )
}
