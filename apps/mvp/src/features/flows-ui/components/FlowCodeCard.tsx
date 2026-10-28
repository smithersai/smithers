import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Textarea } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { codeSaveable } from "../actions"
import { COULDNT_READ_FLOW, DEVICE_STORAGE_UNAVAILABLE, SESSION_STORAGE, NEEDS_SANDBOX, NO_SUCH_FLOW, SAVE, writeRefusalWords } from "../contract"
import { placementOf, SOURCE_PATH } from "../source"
import { useFlowsUi } from "./FlowsUiContext"
import { useEngineStopped } from "../../chat/components/useEngineStopped"
import { COPY_DRAFT, FLOW_UNAVAILABLE } from "../../chat/engineAvailability"

// A flow's code (decision 0014 §1, `/app/flows/code/$name`): its flow.ts to read and edit, and Save, which makes the
// edit the flow's next revision. Code that needs a machine says it needs a sandbox, before and after Save; any other
// code runs in the QuickJS realm. A refused Save says why. Save sits in the card's header, by the file's name, so the toasts that stack at the
// bottom of the screen never cover it below a long file.
export function FlowCodeCard() {
  const stopped = useEngineStopped()
  const { queries, actions } = useFlowsUi()
  const { data: editor } = useLiveQuery(queries.editor)
  const { data: code } = useLiveQuery(queries.code)
  if (stopped && (editor?.state === "unavailable" || code === undefined || code.state === "loading")) return <EmptyState title={FLOW_UNAVAILABLE} />
  if (editor?.state === "unavailable") return <EmptyState title={DEVICE_STORAGE_UNAVAILABLE} />
  if ((editor?.state !== "available" && editor?.state !== "session") || code === undefined || code.state === "loading") return null
  if (code.state !== "read") return <EmptyState title={code.state === "not_found" ? NO_SUCH_FLOW : stopped ? FLOW_UNAVAILABLE : COULDNT_READ_FLOW} />
  return (
    <Card data-draft={(editor.state === "session" || stopped) && code.text !== code.source ? "unsaved" : undefined} aria-label={code.name} className="flows-code">
      <CardHeader className="flows-code-header">
        <CardTitle>{code.name}</CardTitle>
        <span>{SOURCE_PATH}</span>
        <Button disabled={stopped || !codeSaveable(code)} onClick={() => void actions.saveCode(code.refusal === "stale")}>
          {code.refusal === "stale" ? "Overwrite newer revision" : SAVE}
        </Button>
      </CardHeader>
      <CardContent>
        {stopped ? <p role="alert">{FLOW_UNAVAILABLE} {COPY_DRAFT}</p> : null}
        {editor.state === "session" ? <p role="status">{SESSION_STORAGE}</p> : null}
        <Textarea
          code
          aria-label="Code"
          rows={28}
          value={code.text}
          onChange={(event) => actions.editCode(code.name, event.currentTarget.value)}
        />
        {placementOf(code.text) === "sandbox" ? <p role="status">{NEEDS_SANDBOX}</p> : null}
        {code.refusal === null ? null : <p role="alert">{writeRefusalWords(code.refusal)}</p>}
      </CardContent>
    </Card>
  )
}
