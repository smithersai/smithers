import type { Message } from "../chat/schema"
import { isOpen, type Local, type Run } from "../status/schema"
import type { Detail, Entry } from "./schema"

// What an entry the notifications panel expands shows besides its row (decision 0009, docs/features/notifications.md#the-panel):
// pure, from the entry, the answer its run writes (when this device holds it), the person's own run row with its open
// question, and this tab's draft of the answer.

/** How many of a run's steps an expanded entry shows: its last. */
export const STEPS_SHOWN = 3

/** The longest note an expanded entry shows: a finished answer's text, cut here. */
export const MAX_NOTE_LENGTH = 400

/** Why an answer failed, in a word or two (chat's `failure`). */
export const FAILURE_WORDS: Readonly<Record<NonNullable<Message["failure"]>, string>> = {
  quota: "Model credit or quota used up",
  rate_limited: "Rate limited",
  model_error: "Model error",
  empty: "No answer",
  abandoned: "Stopped",
  unfinished: "Unfinished",
}

/** What `detailOf` reads: the entry, and what this device has of its run. */
export interface DetailSources {
  readonly entry: Entry
  /** The answer the run writes, when this device holds its conversation. */
  readonly message: Pick<Message, "text" | "status" | "failure" | "parts"> | undefined
  /** The person's own run row. */
  readonly run: Pick<Run, "status" | "wait" | "version" | "answeredAt"> | undefined
  /** This tab's draft of the answer to the run's question. */
  readonly local: Pick<Local, "version" | "draft" | "sending"> | undefined
}

/**
 * The expanded entry's detail:
 * - `meta`: who pushed to `main` or published the release (a run's is the person's own);
 * - `steps`: the run's last `STEPS_SHOWN` steps;
 * - `note`: why the run failed, or a finished answer's text, cut at `MAX_NOTE_LENGTH`;
 * - `question`: the person's open question on their run, with this tab's draft, to answer in place;
 * - `retry`: Retry shows on the person's failed run in the conversation the tab shows, which can ask it again, and on
 *   the person's failed clone, which can start again anywhere.
 */
export const detailOf = ({ entry, message, run, local }: DetailSources): Detail => {
  const steps = (message?.parts ?? []).slice(-STEPS_SHOWN).map((part) => ({
    id: part.id,
    label: part.flow,
    state: part.status,
  }))
  const text = message?.text.trim() ?? ""
  const note = message === undefined
    ? null
    : message.status === "failed"
    ? FAILURE_WORDS[message.failure ?? "model_error"]
    : entry.state === "done" && text !== ""
    ? (text.length > MAX_NOTE_LENGTH ? `${text.slice(0, MAX_NOTE_LENGTH - 1)}…` : text)
    : null
  const wait = run?.wait ?? null
  const asks = entry.mine && entry.state === "needs_you" && run !== undefined && isOpen(run)
  const drafted = local !== undefined && run !== undefined && local.version === run.version
  return {
    id: entry.id,
    meta: entry.kind === "run" ? null : entry.actor,
    steps,
    note,
    question: asks && wait !== null
      ? {
        kind: wait.kind,
        prompt: wait.prompt,
        options: wait.options,
        draft: drafted ? local.draft : "",
        sending: drafted && local.sending,
      }
      : null,
    retry: entry.action === "retry" ||
      (entry.mine && entry.state === "failed" && entry.here && message?.status === "failed"),
  }
}
