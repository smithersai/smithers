/**
 * The system clipboard, and copy-on-select.
 *
 * The renderer captures the mouse, so the terminal's own selection never
 * starts. opentui tracks the drag itself and emits `selection` on mouse-up;
 * {@link copyOnSelect} writes that text to the clipboard the way a terminal
 * with copy-on-select would.
 */
import { spawnSync } from "node:child_process"

/** Writes `text` to the system clipboard; false when no clipboard command ran. */
export const write = (text: string): boolean => {
  const [command, args] = process.platform === "darwin"
    ? ["pbcopy", []]
    : ["xclip", ["-selection", "clipboard"]]
  return spawnSync(command, args, { input: text }).status === 0
}

/** The part of the renderer this module needs. */
export interface SelectionSource {
  on(event: "selection", listener: (selection: { getSelectedText(): string }) => void): unknown
  off(event: "selection", listener: (selection: { getSelectedText(): string }) => void): unknown
}

/**
 * Copies every finished non-empty selection through `copy` and reports it to
 * `onCopied`. Returns the unsubscribe.
 */
export const copyOnSelect = (
  source: SelectionSource,
  copy: (text: string) => boolean,
  onCopied: (text: string) => void
): () => void => {
  const listener = (selection: { getSelectedText(): string }) => {
    const text = selection.getSelectedText()
    if (text.trim() === "") return
    if (copy(text)) onCopied(text)
  }
  source.on("selection", listener)
  return () => source.off("selection", listener)
}
