/**
 * Split an `AGENTS.md` file into the chunks a relevance reading judges, then
 * render the project-instructions block with one bullet withheld.
 */
import * as Relevance from "../src/Relevance.vibe"

const agents: Relevance.Document = {
  path: "/repo/AGENTS.md",
  text: "# Rules\n\n- Run the tests before landing.\n- Write docs in the imperative.\n  Keep sentences short.\n"
}

/** Lists the chunk ids and renders the block without the docs bullet. */
export const instructionChunks = (): {
  readonly ids: ReadonlyArray<string>
  readonly rejoined: boolean
  readonly rendered: string
} => {
  const chunks = Relevance.chunks([agents])
  // A wrapped line belongs to its bullet, so withholding the bullet drops both.
  const docs = chunks.find((chunk) => chunk.text.startsWith("- Write docs"))!
  return {
    ids: chunks.map((chunk) => chunk.id),
    rejoined: chunks.map((chunk) => chunk.text).join("") === agents.text,
    rendered: Relevance.render([agents], new Set([docs.id]))
  }
}
