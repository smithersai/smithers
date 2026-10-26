import { FlowDraftView } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { DEVICE_STORAGE_UNAVAILABLE, draftFailureWords, MINE, SAVE_REFUSALS } from "../contract"
import { shownRound } from "../round"
import { useFlowsUi } from "./FlowsUiContext"

// One draft at full size (decision 0014 §5): its round's status, as its row says or, when the round's run on this
// device ended without writing it, Failed with why; questions with the defaults it assumed, its flow.ts and checks;
// Answer, Draft again on a failed round, Save once it is ready and every check passed, and Delete.
export function DraftCard() {
  const { queries, actions } = useFlowsUi()
  const { data: editor } = useLiveQuery(queries.editor)
  const { data } = useLiveQuery(queries.draft)
  const { data: unsent } = useLiveQuery(queries.answers)
  const { data: run } = useLiveQuery(queries.round)
  if (data === undefined) return null
  const { draft, shown } = data
  const answers = Object.fromEntries(
    (unsent ?? []).filter((answer) => answer.draftId === draft.id).map((answer) => [answer.questionId, answer.value]),
  )
  const round = shownRound(draft, run)
  const saveable = round.status === "ready" && draft.checks.length > 0 && draft.checks.every((check) => check.ok)
  return (
    <>
      <FlowDraftView
        where={MINE}
        name={draft.name ?? ""}
        request={draft.request}
        status={round.status}
        round={draft.round}
        questions={draft.questions}
        answers={answers}
        files={draft.files}
        checks={draft.checks}
        failure={round.failure === null ? null : draftFailureWords(round.failure)}
        {...(editor?.state === "available" ? { onAnswerChange: (id: string, value: string) => actions.setAnswer(draft.id, id, value), onAnswer: actions.answer } : {})}
        {...(round.retry ? { onRetry: actions.draftAgain } : {})}
        {...(draft.status === "saved" ? {} : { onSave: actions.save, saveDisabled: !saveable || shown.busy })}
        {...(draft.status === "saved" || draft.status === "proposed" ? {} : { onDelete: () => actions.deleteDraft(draft.id) })}
      />
      {editor?.state === "unavailable" ? <p role="alert">{DEVICE_STORAGE_UNAVAILABLE}</p> : null}
      {shown.refusal === null ? null : <p role="alert">{SAVE_REFUSALS[shown.refusal] ?? shown.refusal}</p>}
    </>
  )
}
