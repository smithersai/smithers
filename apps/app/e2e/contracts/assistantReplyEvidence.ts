/** One rendered chat bubble as the browser tier reads it out of the transcript. */
export interface TranscriptBubble {
  readonly role: string
  readonly text: string
  readonly pending: boolean
}

const turnsWith = (bubbles: ReadonlyArray<TranscriptBubble>, prompt: string): number =>
  bubbles.filter((bubble) => bubble.role === "user" && bubble.text.includes(prompt)).length

/**
 * Evidence that this send produced a reply, not that the transcript happens
 * to end in an assistant bubble.
 *
 * The app renders completed assistant bubbles at boot (initialization, then
 * the auth state), so a send that starts no turn leaves a visible, non-empty
 * assistant bubble with no status marker. Evidence therefore requires a user
 * turn this send appended and a completed assistant bubble rendered after
 * it. Bubbles are only appended, so anything below the submitted turn is new.
 */
export const assistantReplyEvidence = (
  before: ReadonlyArray<TranscriptBubble>,
  after: ReadonlyArray<TranscriptBubble>,
  prompt: string
): TranscriptBubble | undefined => {
  const wanted = prompt.trim()
  if (turnsWith(after, wanted) <= turnsWith(before, wanted)) return undefined
  let turn = -1
  for (let index = after.length - 1; index >= 0; index -= 1) {
    if (after[index]!.role === "user" && after[index]!.text.includes(wanted)) {
      turn = index
      break
    }
  }
  if (turn === -1) return undefined
  return after.slice(turn + 1).find((bubble) =>
    bubble.role === "assistant" && bubble.text.trim() !== "" && !bubble.pending
  )
}
