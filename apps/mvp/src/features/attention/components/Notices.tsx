import { Toast, ToastStack } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { ReactElement } from "react"
import type { Surface } from "../contract"
import { TRY_AGAIN } from "../../repo/contract"
import type { Entry } from "../schema"
import { useAttention } from "./AttentionContext"

// Current notices reserve space; older and overflow entries stay in the bell.
export function useNotices(surface: Surface): {
  readonly toasts: ReadonlyArray<ReactElement>
} {
  const { queries } = useAttention()
  const { data: stack } = useLiveQuery(surface === "conversation" ? queries.stackHere : queries.stack)
  return {
    toasts: stack.map((entry) => <Notice key={`${entry.id}:${entry.version}`} entry={entry} surface={surface} />),
  }
}

/** The stack on a page with nothing else to show: the feed alone. */
export function Notices({ surface, placement }: { readonly surface: Surface; readonly placement: "fixed" | "inline" }) {
  const { toasts } = useNotices(surface)
  return (
    <ToastStack label="Smithers" placement={placement}>
      {toasts.slice(0, 3)}
    </ToastStack>
  )
}

function Notice({ entry, surface }: { readonly entry: Entry; readonly surface: Surface }) {
  const { actions } = useAttention()
  const answers = entry.action === "answer"
  const retries = entry.action === "retry"
  return (
    <Toast
      tone={entry.state}
      delayed
      {...(entry.word === null ? {} : { word: entry.word })}
      {...(entry.detail === null ? {} : { detail: entry.detail })}
      unread={entry.unread}
      onOpen={() => actions.open(entry.id, surface)}
      {...(entry.local === true ? {} : { onExpand: () => actions.openPanel("toast", entry.id), onRead: () => actions.read(entry.id) })}
      {...(answers
        ? { action: { label: "Answer", onAction: () => actions.open(entry.id, surface) }, onAnswer: () => actions.answer(entry.id, surface) }
        : retries
        ? { action: { label: TRY_AGAIN, onAction: () => actions.retry(entry.id) } }
        : {})}
      {...(entry.local === true ? {} : { onHide: () => actions.hide(entry.id) })}
      data-subject={entry.id}
      {...(entry.runId === null ? {} : { "data-run": entry.runId })}
    />
  )
}
