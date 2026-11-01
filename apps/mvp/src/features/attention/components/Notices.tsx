import { Toast, ToastStack } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { ReactElement } from "react"
import { MODEL_NOTICE, type Surface } from "../contract"
import { OPEN_SETTINGS } from "../../auth/contract"
import { TRY_AGAIN } from "../../repo/contract"
import type { Entry } from "../schema"
import { useAttention } from "./AttentionContext"

// Core overlay layout: shared headers/toolbars and primary buttons, including plugin controls.
// A custom primary action can opt in with data-primary-action (decision 0137).
const CLEAR_OF = ':is(header, [role="toolbar"], .home-tabs, .file-tabs-bar, .branch-header, .mvp-pin-actions, .sui-button-solid, .sui-button-default, .sui-rh-action-primary, [data-primary-action]):not(.sui-msg-scroller *, .sui-chat-messages *)'

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
 * The feed's stack, hung under its page's header or the home conversation's pin (decision 0137): `ToastStack`'s
 * `anchored` placement, rendered inside a positioned element. It overlays what follows and takes no layout
 * space. Actual header and primary-action bounds clear the overlay on every page and width,
 * so a toast arriving or leaving never moves the conversation, the composer or the page. `surface` picks the
 * entries: over a conversation, its own runs show in it instead, unless they need you.
 */
export function Notices({ surface }: { readonly surface: Surface }) {
  const { toasts } = useNotices(surface)
  return (
    <ToastStack label="Smithers" placement="anchored" avoid={CLEAR_OF}>
      {toasts.slice(0, 3)}
    </ToastStack>
  )
}

function Notice({ entry, surface }: { readonly entry: Entry; readonly surface: Surface }) {
  const { actions } = useAttention()
  const model = entry.id === MODEL_NOTICE
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
      {...(model
        ? { action: { label: OPEN_SETTINGS, onAction: () => actions.open(entry.id, surface) } }
        : answers
        ? { action: { label: "Answer", onAction: () => actions.open(entry.id, surface) }, onAnswer: () => actions.answer(entry.id, surface) }
        : retries
        ? { action: { label: TRY_AGAIN, onAction: () => actions.retry(entry.id) } }
        : {})}
      {...(entry.local === true && !model ? {} : { onHide: () => actions.hide(entry.id) })}
      {...(model ? { "data-add-model": "" } : {})}
      data-subject={entry.id}
      {...(entry.runId === null ? {} : { "data-run": entry.runId })}
    />
  )
}
