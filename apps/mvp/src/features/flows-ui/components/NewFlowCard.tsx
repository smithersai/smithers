import { EmptyState, FlowDraftView } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { formReady } from "../actions"
import { DEVICE_STORAGE_UNAVAILABLE, MINE } from "../contract"
import { nameHint, requestHint } from "../hints"
import { useFlowsUi } from "./FlowsUiContext"

// The new-flow form (decision 0014 §5, the draft card before its first round): the flow's name and what it should do,
// then Draft. A name you already have drafts its next revision.
export function NewFlowCard() {
  const { queries, actions } = useFlowsUi()
  const { data: editor } = useLiveQuery(queries.editor)
  const { data: form } = useLiveQuery(queries.form)
  if (editor?.state === "unavailable") return <EmptyState title={DEVICE_STORAGE_UNAVAILABLE} />
  if (editor?.state !== "available" || form === undefined) return null
  return (
    <FlowDraftView
      where={MINE}
      name={form.name}
      request={form.request}
      nameHint={nameHint(form.name)}
      requestHint={requestHint(form.request)}
      status={null}
      round={0}
      questions={[]}
      answers={{}}
      files={[]}
      checks={[]}
      onNameChange={actions.setName}
      onRequestChange={actions.setRequest}
      {...(formReady(form) ? { onStart: actions.startDraft } : {})}
    />
  )
}
