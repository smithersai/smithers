import { Terminal } from "@smthrs/ui/adapters/terminal"
import { useRef } from "react"
import { useController } from "../ControllerContext"
import type { TabRow } from "../state/AppState"

/*
 * A terminal or harness tab's body (docs/LOCAL-APP.md "Tabs"): the shipped
 * `@smthrs/ui` xterm adapter (@xterm/xterm + @xterm/addon-fit) attached to
 * `pty:<sessionId>` over `/ws`.
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
  /*
   * Lane citc: a workspace terminal attaches to its cloud session through
   * the `/api/cloud-ws/` tunnel; a local one to `pty:<sessionId>` over /ws.
   * Same three seams either way.
   */
  const workspace = tab.kind === "terminal" && tab.workspaceId !== undefined && tab.repo !== undefined
    ? { workspaceId: tab.workspaceId, repo: tab.repo }
    : undefined
  /* The last geometry sent, so a refit that changed nothing sends nothing. */
  const lastGeometry = useRef("")
  return (
    <Terminal
      className="tab-terminal"
      data-testid={`terminal-${sessionId}`}
      stream={(write) =>
        workspace !== undefined
          ? controller.cloudTerminal.attach(workspace.repo, sessionId, { onOutput: write })
          : controller.pty.attach(sessionId, {
            onOutput: write,
            onExit: (code) => {
              write(`\r\nprocess exited (${code === null ? "null" : String(code)})\r\n`)
              controller.notePtyExit(sessionId, code)
            }
          })}
      onData={(data) =>
        workspace !== undefined
          ? controller.cloudTerminal.input(sessionId, data)
          : controller.pty.input(sessionId, data)}
      onResize={({ cols, rows }) => {
        // The adapter refits on every host resize; only a changed geometry reaches the server.
        const geometry = `${cols}x${rows}`
        if (geometry === lastGeometry.current || cols === 0 || rows === 0) return
        lastGeometry.current = geometry
        if (workspace !== undefined) controller.cloudTerminal.resize(sessionId, cols, rows)
        else void controller.pty.resize(sessionId, cols, rows)
      }}
    />
  )
}
