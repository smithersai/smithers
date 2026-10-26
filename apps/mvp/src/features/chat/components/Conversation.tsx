import { PinControl } from "../../pins/PinControl"
import { PinnedMessage } from "../../pins/PinnedMessage"
import { TimelineContribution } from "../../timeline/TimelineContribution"
import { Badge, Button, ChatMessage, ChatTranscript, CopyButton, MessageResponse, RelativeTime, Wordmark } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { RailTodo } from "../../timeline/view"
import { todoPath } from "../../todos/contract"
import { Link, useNavigate } from "@tanstack/react-router"
import { Fragment, type ReactNode } from "react"
import { useChat } from "../../../AppContext"
import { AnswerStatus } from "../../status/components/AnswerStatus"
import { useTodos } from "../../todos/components/TodosContext"
import { AnswerDrafts } from "../../todos/components/AnswerDrafts"
import { useStatus } from "../../status/components/StatusContext"
import { ConversationView } from "../../views/components/ConversationView"
import { COPY, DEBUG_INFO, EDIT, NOT_SENT, QUEUED } from "../contract"
import { debugRunOf, timeOf } from "../view"

// The conversation on this device: never a loading state. Until it is restored or synced it is blank, never the empty
// state. "Load earlier" heads it while the device has messages before the window. A queued question is badged only
// while the connection pill shows, with Edit; an unsent one offers Edit or Retry, and Discard; a failed answer offers
// Retry; a finished message offers Copy. Every message shows when it was asked or written; its time, Copy and a queued
// question's Edit show only while the pointer is over it, focus is inside it, or it is tapped; so does an answer's debug
// info, an icon that opens the run that answered it: its flows and steps (src/features/runs). A view
// (src/features/views) shows where it was added, from its own row. An answer shows its agent status under it
// (src/features/status): its question while it needs you, in place of an empty bubble. Empty, it shows `empty`: the
// wordmark on /app, the branch's own empty state on a branch's page.
export function Conversation({ empty = <Wordmark />, readOnly = false, timelineTodos = [], timelineRepo }: { readonly empty?: ReactNode; readonly readOnly?: boolean; readonly timelineTodos?: readonly RailTodo[]; readonly timelineRepo?: { readonly owner: string; readonly name: string } } = {}) {
  const navigate = useNavigate()
  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "instant" })
  }
  const activate = (id: string) => {
    const todo = timelineTodos.find(todo => `todo:${todo.id}` === id)
    if (todo && timelineRepo) { void navigate({ href: todoPath(timelineRepo.owner, timelineRepo.name, todo.number) }); return }
    jump(id)
  }
  const { queries, actions } = useChat()
  const { data: drafts } = useLiveQuery(useTodos().queries.drafts)
  // The conversation this tab shows: the branch's on a branch's page (decision 0013 §1), the home one on /app.
  const { data: place } = useLiveQuery(queries.place)
  const shown = queries.of(place?.conversationId)
  const status = useStatus().queries.of(place?.conversationId)
  const { data: statuses } = useLiveQuery(status.statuses)
  const { data: conversation } = useLiveQuery(shown.conversation)
  const { data: pinned } = useLiveQuery(shown.pinned)
  const { data: collapsedPins } = useLiveQuery(queries.pinCollapsed)
  const { data: pinPending } = useLiveQuery(queries.pinPending)
  const failedPin = pinPending.find(row => row.failed && (row.home ? place?.conversationId == null : row.conversationId === place?.conversationId))
  const pin = pinned[0]
  const collapsed = pin === undefined ? false : collapsedPins.some(row => row.id === pin.id && row.collapsed)
  const { data: history } = useLiveQuery(shown.history)
  const { data: connection } = useLiveQuery(queries.connection)
  const pill = connection !== undefined && connection.status !== "up"
  return (
    <div className="mvp-conversation">
    {failedPin === undefined ? null : <Button variant="ghost" size="sm" aria-label={failedPin.messageId === null ? "Retry unpin" : "Retry pin"} onClick={() => actions.retryPin(failedPin.conversationId)}>Retry</Button>}
    {pin === undefined ? null : <PinnedMessage message={pin} collapsed={collapsed} onUnpin={actions.unpin} onCollapse={() => actions.collapsePin(pin.id, !collapsed)} />}
    <ChatTranscript empty={history?.opened === true ? empty : null} rail={<TimelineContribution messages={conversation} statuses={statuses} drafts={readOnly ? [] : drafts} todos={timelineTodos} onJump={jump} onActivate={activate} />}>
      {history?.earlier === true ? (
        <Button variant="ghost" size="sm" onClick={actions.loadEarlier}>
          Load earlier
        </Button>
      ) : null}
      {conversation.map((message) =>
        message.role === "view" ? (
          <ConversationView
            key={message.id}
            id={message.id}
            {...(place?.conversationId == null ? {} : { conversationId: place.conversationId })}
          />
        ) : (
        // One element per message from the moment it shows, so a question syncing or an answer settling doesn't
        // replay the fade-in. Only an unsent question can share its id with a synced row (another message took it).
        <Fragment key={message.status === "unsent" ? `unsent:${message.id}` : message.id}>
        {message.role === "assistant" && message.text === "" &&
            statuses.find((status) => status.id === message.id)?.state === "needs_you" ? null : (
        <ChatMessage
          role={message.role}
          // An answer's id is its run's: a notification opens `#<run id>`, and the router scrolls it into view.
          id={message.status === "unsent" ? `unsent:${message.id}` : message.id}
          data-id={message.id}
          data-state={message.status}
          data-answer={message.status === "streaming" ? "streaming" : undefined}
          pending={message.status === "streaming" && message.text === ""}
          pendingLabel="Smithers is answering"
          actions={
            <>
            <PinControl pinned={pin?.id === message.id && pin.local === message.local} onClick={() => pin?.id === message.id && pin.local === message.local ? actions.unpin() : actions.pin(message.id, message.local === 1)} />
            {timeOf(message) === undefined ? null : <RelativeTime ts={timeOf(message)!} />}
            {message.status === "done" ? (
              <CopyButton variant="ghost" size="sm" onCopy={() => actions.copy(message.id)}>
                {COPY}
              </CopyButton>
            ) : message.status === "queued" && pill && !readOnly ? (
              <Button variant="ghost" size="sm" onClick={() => actions.edit(message.id)}>
                {EDIT}
              </Button>
            ) : null}
            {debugRunOf(message) === undefined ? null : (
              <Button asChild variant="ghost" size="sm">
                <Link to="/app/runs/$runId" params={{ runId: debugRunOf(message)! }} aria-label={DEBUG_INFO} title={DEBUG_INFO}>
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <circle cx="3.5" cy="8" r="2" />
                    <circle cx="12.5" cy="3.5" r="2" />
                    <circle cx="12.5" cy="12.5" r="2" />
                    <path d="M5.5 8h2.5l2.6-3.4M8 8l2.6 3.4" />
                  </svg>
                </Link>
              </Button>
            )}
            </>
          }
          meta={
            message.status === "queued" && pill ? (
              <Badge variant="muted">{QUEUED}</Badge>
            ) : message.status === "unsent" ? (
              <>
                <Badge variant="destructive">{NOT_SENT}</Badge>
                {!readOnly && message.sendAgain ? (
                  <Button variant="ghost" size="sm" onClick={() => actions.resendUnsent(message.id)}>
                    Retry
                  </Button>
                ) : !readOnly ? (
                  <Button variant="ghost" size="sm" onClick={() => actions.editUnsent(message.id)}>
                    {EDIT}
                  </Button>
                ) : null}
                {readOnly ? null : <Button variant="ghost" size="sm" onClick={() => actions.discardUnsent(message.id)}>
                  Discard
                </Button>}
              </>
            ) : message.status === "failed" && !readOnly ? (
              <Button variant="ghost" size="sm" onClick={() => actions.retryAnswer(message.id)}>
                Retry
              </Button>
            ) : null
          }
        >
          {message.role === "assistant" ? (
            <MessageResponse content={message.text} streaming={message.status === "streaming"} />
          ) : (
            message.text
          )}
        </ChatMessage>
        )}
        {message.role === "assistant" ? <span id={`run:${message.id}`} /> : null}
        {message.role === "assistant" && !readOnly ? <div id={message.text === "" && statuses.find(status => status.id === message.id)?.state === "needs_you" ? message.id : undefined}><AnswerStatus id={message.id} statuses={status.statuses} /></div> : null}
        {/* A TODO the agent drafted in this answer, private to this device until the person commits it (0016 §3). */}
        {message.role === "assistant" && !readOnly ? <AnswerDrafts id={message.id} /> : null}
        </Fragment>
        ),
      )}
    </ChatTranscript>
    </div>
  )
}
