import { Toast, ToastStack } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { ReactElement } from "react"
import type { Surface } from "../contract"
import { TRY_AGAIN } from "../../repo/contract"
import type { Entry } from "../schema"
import { useAttention } from "./AttentionContext"

// The current notices, at most three; older and overflow entries stay in the bell.
export function useNotices(surface: Surface): {
  readonly toasts: ReadonlyArray<ReactElement>
} {
  const { queries } = useAttention()
  const { data: stack } = useLiveQuery(surface === "conversation" ? queries.stackHere : queries.stack)
  return {
    toasts: stack.map((entry) => <Notice key={`${entry.id}:${entry.version}`} entry={entry} surface={surface} />),
  }
}

/**
 * The feed's stack, hung under the header of the page it is on (decision 0137): `ToastStack`'s `anchored` placement,
 * so render it inside a positioned element, right after the header. It overlays what follows and takes no layout
 * space, so a toast arriving or leaving never moves the conversation, the composer or the page. `surface` picks the
 * entries: over a conversation, its own runs show in it instead, unless they need you.
 */
export function Notices({ surface }: { readonly surface: Surface }) {
  const { toasts } = useNotices(surface)
  return (
    <ToastStack label="Smithers" placement="anchored">
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
