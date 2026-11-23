import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Snippet } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useLocation } from "@tanstack/react-router"
import { useAuth } from "../../auth/components/AuthContext"
import { signInHref } from "../../auth/contract"
import { useRepoAnswer } from "../../repo/components/RepoContext"
import { MCP_CLIENTS } from "../contract"
import { ACTING_AS, CLIENT_LABEL, CLIENTS, CONNECT_AGENT, connectTitle, COPY_SNIPPET, SIGNED_OUT_NOTE } from "../copy"
import { connectDialogView } from "../view"
import { AgentPermissions } from "./AgentPermissions"
import { useMcpOptional } from "./McpContext"
import "./connect-agent.css"

// "Connect agent" on a repository's header: a compact button that opens the dialog for repository `owner/name`. The
// dialog shows one client preset's copyable snippet at a time (Claude Code, Codex, Cursor, Streamable HTTP, CLI /
// Stdio), who the agent acts as, and what the viewer's live role on this repository lets it do and never do. Whether
// the dialog is open and which client shows are rows of a local-only collection (store.ts), never component state.
export function ConnectAgentButton({ owner, name }: { readonly owner: string; readonly name: string }) {
  const mcp = useMcpOptional()
  if (mcp === null) return null
  return <ConnectAgentButtonInner owner={owner} name={name} mcp={mcp} />
}

function ConnectAgentButtonInner({ owner, name, mcp }: { readonly owner: string; readonly name: string; readonly mcp: NonNullable<ReturnType<typeof useMcpOptional>> }) {
  const { queries, actions } = mcp
  const auth = useAuth()
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: connect } = useLiveQuery(queries.connect)
  const answer = useRepoAnswer(owner, name)
  const location = useLocation()
  const open = connect?.open === true && connect.owner === owner && connect.name === name
  const client = connect?.client ?? MCP_CLIENTS[0]
  const login = session?.status === "signed_in" ? session.login : null
  const view = connectDialogView(client, window.location.origin, owner, name, answer?.role ?? null, login)
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => actions.openConnect(owner, name)}>{CONNECT_AGENT}</Button>
      <Dialog open={open} onOpenChange={(next) => (next ? actions.openConnect(owner, name) : actions.closeConnect())}>
        {open
          ? (
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{connectTitle(owner, name)}</DialogTitle>
                <DialogDescription>{view.signedIn ? view.snippet.note : SIGNED_OUT_NOTE}</DialogDescription>
              </DialogHeader>
              <div className="connect-agent">
                <div className="connect-agent-clients" role="group" aria-label={CLIENTS}>
                  {MCP_CLIENTS.map((each) => (
                    <Button
                      key={each}
                      size="sm"
                      variant={each === client ? "secondary" : "ghost"}
                      aria-pressed={each === client}
                      onClick={() => actions.selectClient(each)}
                    >
                      {CLIENT_LABEL[each]}
                    </Button>
                  ))}
                </div>
                <div className="connect-agent-snippet">
                  <p>{view.snippet.label}</p>
                  <Snippet code={view.snippet.command} copyLabel={COPY_SNIPPET} />
                  {view.signedIn ? null : <p>{view.snippet.note}</p>}
                </div>
                <AgentPermissions
                  roleLabel={view.roleLabel}
                  allowed={view.allowed}
                  blocked={view.blocked}
                  who={view.signedIn
                    ? <span>{ACTING_AS} <strong>{view.actor}</strong></span>
                    : (
                      <Button asChild size="sm" variant="solid">
                        <a href={signInHref(`${location.pathname}${location.searchStr}`)} onClick={auth.actions.pressSignIn}>{view.actor}</a>
                      </Button>
                    )}
                />
              </div>
            </DialogContent>
          )
          : null}
      </Dialog>
    </>
  )
}
