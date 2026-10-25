import { SpendAlertEntries } from "../../spend/components/SpendAlertEntries"
import { Button, NeedsYouCard, NotificationEntry, NotificationPanel, RelativeTime } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useRouterState } from "@tanstack/react-router"
import { useBranch } from "../../branch/components/BranchContext"
import { openAnswerOf } from "../../coedit/view"
import { useStatus } from "../../status/components/StatusContext"
import { surfaceOf } from "../contract"
import type { Detail, Entry } from "../schema"
import { useAttention } from "./AttentionContext"

// The notifications panel (decision 0009, docs/features/notifications.md#the-panel), on every page: the person's
// entries newest first, unread ones dotted. Clicking an entry expands it in place: the run's last steps, its question
// with Answer, why it failed with Retry, or who pushed or published; Open goes there. The bell, `+N`, a toast's E and
// Alt+N open it; Escape, × or a click outside close it.
export function NotificationsPanel() {
  const { queries, actions } = useAttention()
  const surface = surfaceOf(useRouterState({ select: (state) => state.matches.at(-1)?.routeId }))
  const { data: panel } = useLiveQuery(queries.panel)
  const { data: feed } = useLiveQuery(queries.feed)
  const { data: detail } = useLiveQuery(queries.detail)
  return (
    <NotificationPanel
      open={panel?.open === true}
      onOpenChange={(open) => (open ? actions.openPanel("key") : actions.closePanel())}
      focus={panel?.focus}
    >
      <SpendAlertEntries expanded={panel?.expanded ?? null} onExpand={actions.expand} />
      {feed.map((entry) => (
        <Notification
          key={entry.id}
          entry={entry}
          surface={surface}
          expanded={panel?.expanded === entry.id}
          detail={detail?.id === entry.id ? detail : undefined}
          answerRequest={panel?.answer ?? 0}
        />
      ))}
    </NotificationPanel>
  )
}

function Notification({ entry, surface, expanded, detail, answerRequest }: {
  readonly entry: Entry
  readonly surface: ReturnType<typeof surfaceOf>
  readonly expanded: boolean
  readonly detail: Detail | undefined
  readonly answerRequest: number
}) {
  const { actions } = useAttention()
  const status = useStatus()
  const { coedit } = useBranch()
  const { data: texts } = useLiveQuery(coedit.queries.texts)
  const question = detail?.question ?? null
  const runId = entry.runId
  // The open question's field is a text the person's devices type together (docs/features/coedit.md).
  const shared = runId === null ? undefined : openAnswerOf(texts, runId)
  return (
    <NotificationEntry
      entryId={entry.id}
      tone={entry.state}
      {...(entry.word === null ? {} : { word: entry.word })}
      {...(entry.detail === null ? {} : { detail: entry.detail })}
      time={<RelativeTime ts={entry.atMs} />}
      unread={entry.unread}
      expanded={expanded}
      onExpandedChange={() => actions.expand(entry.id)}
      onOpen={() => actions.open(entry.id, surface)}
      {...(entry.action === "answer" ? { onAnswer: () => actions.answer(entry.id, "panel") } : {})}
      onRead={() => actions.read(entry.id)}
      hideLabel={entry.settled ? "Dismiss" : "Hide"}
      onHide={() => (entry.settled ? actions.dismiss(entry.id) : actions.hide(entry.id))}
      {...(detail?.meta == null ? {} : { meta: detail.meta })}
      {...(detail === undefined ? {} : { steps: detail.steps })}
      {...(detail?.note == null ? {} : { note: detail.note })}
      {...(detail?.retry === true
        ? {
          actions: (
            <Button size="sm" variant="outline" onClick={() => actions.retry(entry.id)}>
              Retry
            </Button>
          ),
        }
        : {})}
      data-subject={entry.id}
    >
      {question === null || runId === null ? null : (
        <NeedsYouCard
          compact
          kind={question.kind}
          prompt={question.prompt}
          options={question.options}
          value={shared?.text ?? question.draft}
          sending={question.sending}
          focusRequest={answerRequest === 0 ? undefined : answerRequest}
          onValueChange={(text, selection) =>
            shared === undefined
              ? status.actions.setDraft(runId, text)
              : coedit.actions.type(shared.id, text, { base: shared.text, selection })}
          collaborators={shared?.collaborators}
          selection={shared?.selection ?? undefined}
          onSelectionChange={shared === undefined ? undefined : (selection) => coedit.actions.select(shared.id, selection)}
          onAnswer={(value) => status.actions.answer(runId, value)}
        />
      )}
    </NotificationEntry>
  )
}
