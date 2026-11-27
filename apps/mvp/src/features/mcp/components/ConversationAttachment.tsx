import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Snippet } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useCallback } from "react"
import type { Target } from "../attachment.vibe"
import { useMcpOptional } from "./McpContext"

const failureText: Record<string, string> = {
  not_claimed: "Start the command in your agent's terminal, then check again.",
  unknown_reference: "This reference expired. Start again.",
  consent_expired: "Review the request again.",
  wrong_pairing: "The pairing code didn't match.",
  forbidden: "You no longer have access to this conversation.",
  wrong_target: "The requested conversation doesn't match.",
}

export function ConversationAttachment({ target }: { readonly target: Target }) {
  const mcp = useMcpOptional()
  return mcp ? <PairConversation key={target.conversation} target={target} mcp={mcp} /> : null
}

function PairConversation({ target, mcp }: { readonly target: Target; readonly mcp: NonNullable<ReturnType<typeof useMcpOptional>> }) {
  const { data: row } = useLiveQuery(mcp.queries.pairing)
  const { actions } = mcp
  const mounted = useCallback((element: HTMLDivElement | null) => {
    if (element === null) actions.closeAttachment()
  }, [actions])
  const open = row?.target?.conversation === target.conversation
  return <div ref={mounted} id="attach-agent">
    <Button size="sm" variant="outline" onClick={() => void actions.mintAttachment(target)}>Attach agent</Button>
    <Dialog open={open} onOpenChange={next => { if (!next) actions.closeAttachment() }}>
      {open && row ? <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach agent</DialogTitle>
          <DialogDescription>{target.repo} · {target.branch}</DialogDescription>
        </DialogHeader>
        {row.approval ? <>
          <p>Enter this approval code in the terminal showing your pairing code.</p>
          <Snippet code={row.approval.code} copyLabel="Copy approval code" />
          <Button variant="outline" disabled={row.busy} onClick={() => void actions.revokeAttachment()}>Revoke access</Button>
        </> : <>
          {row.reference && <>
            <p>Run in your agent's terminal</p>
            <Snippet code={`smthrs attach --origin ${window.location.origin} --intent ${row.reference}`} copyLabel="Copy attach command" />
          </>}
          {row.review && <form onSubmit={event => {
            event.preventDefault()
            const code = new FormData(event.currentTarget).get("pairing")
            if (typeof code === "string") void actions.approveAttachment(code)
          }}>
            <p><strong>{row.review.client}</strong> requests access to {row.review.repo} · {row.review.branch}.</p>
            <p>{row.review.ceiling.includes("conversation:write") ? "Read this conversation and answer your questions." : "Read this conversation."}</p>
            <label>Pairing code <input name="pairing" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="off" /></label>
            <Button type="submit" disabled={row.busy}>Approve attachment</Button>
          </form>}
          {row.reference && (!row.review || row.error === "consent_expired") && <Button disabled={row.busy} onClick={() => void actions.reviewAttachment()}>Review request</Button>}
        </>}
        {row.error && <p role="alert">{failureText[row.error] ?? "Couldn't complete the request."}</p>}
        {row.error && (!row.reference || row.error === "unknown_reference") && <Button onClick={() => void actions.mintAttachment(target)}>Start again</Button>}
        {row.busy && <span role="status">Waiting…</span>}
      </DialogContent> : null}
    </Dialog>
  </div>
}
