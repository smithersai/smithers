/*
 * The World, as the model reads it (§10.8).
 *
 * The World pane's own subtitle is "what Smithers currently understands", and
 * the per-turn runtime context carried world notes by METADATA ONLY — path,
 * title, confidence. A note recording a fact written down nowhere else was
 * therefore invisible: asked what it said, the model answered that it could
 * not retrieve it and reached for a repository file read instead. The feature
 * was decorative.
 *
 * Sending every body on every turn is the other failure — the World is
 * unbounded and a turn's context is not. So bodies ride the turn under a
 * character budget, spent in the order the user cares about: the note open in
 * the pane first, then the rest in the order the snapshot already sorts them.
 * A note cut by the budget says so; the model is never left to infer that
 * silence means the note is empty.
 */
import type { AgentRuntimeWorldDocument } from "@smthrs/rpc/AgentContext"

/** What the caller must supply per note. `AppState`'s WorldDocument satisfies it. */
export interface WorldContextInput {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly body: string
  readonly confidence: number
}

/**
 * How much note text one turn may carry, in characters.
 *
 * Roughly two thousand tokens across the whole World, which is the same order
 * as the transcript window the turn already spends and small enough that a
 * large World cannot crowd the conversation out of context.
 */
export const WORLD_BODY_BUDGET = 8000

/** How much of that budget any single note may take, so one long note cannot eat it all. */
export const WORLD_BODY_PER_DOCUMENT = 4000

/** Cut a body to `room`, on a line boundary when one is close to the end. */
const head = (body: string, room: number): string => {
  if (body.length <= room) return body
  const cut = body.slice(0, room)
  const lastBreak = cut.lastIndexOf("\n")
  return lastBreak > room * 0.5 ? cut.slice(0, lastBreak) : cut
}

/**
 * The world documents as the runtime context carries them: metadata for every
 * note, plus as much of each body as the budget allows, spent selected-note
 * first. Output order is the caller's order, so the list the model reads is
 * the list the pane shows.
 */
export const worldContextDocuments = (
  documents: ReadonlyArray<WorldContextInput>,
  selectedId: string | null,
  budget = WORLD_BODY_BUDGET,
  perDocument = WORLD_BODY_PER_DOCUMENT
): Array<AgentRuntimeWorldDocument> => {
  // The open note is the one the user is asking about; it is served first
  // however the snapshot happens to be sorted.
  const order = [...documents].sort((left, right) => {
    if (left.id === right.id) return 0
    if (left.id === selectedId) return -1
    if (right.id === selectedId) return 1
    return 0
  })
  const bodies = new Map<string, { readonly body: string; readonly truncated: boolean }>()
  let spent = 0
  for (const document of order) {
    const body = document.body.trim()
    if (body === "") {
      bodies.set(document.id, { body: "", truncated: false })
      continue
    }
    const room = Math.max(0, Math.min(perDocument, budget - spent))
    const carried = head(body, room)
    spent += carried.length
    bodies.set(document.id, { body: carried, truncated: carried.length < body.length })
  }
  return documents.map((document) => {
    const carried = bodies.get(document.id)
    return {
      path: document.path,
      title: document.title,
      confidence: document.confidence,
      body: carried?.body ?? "",
      ...(carried?.truncated === true ? { bodyTruncated: true } : {})
    }
  })
}
