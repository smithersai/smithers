/** OpenTUI offsets are display columns; completion spans are UTF-16 indices. */
import type { TextareaRenderable } from "@opentui/core"

type Input = Pick<TextareaRenderable, "cursorOffset" | "editBuffer" | "plainText" | "gotoBufferEnd">

/** Ask the native buffer for the exact prefix, including tabs and graphemes. */
export const index = (input: Pick<Input, "cursorOffset" | "editBuffer">): number =>
  input.editBuffer.getTextRange(0, input.cursorOffset).length

/** Set a JS string position using the same width rules the editor uses. */
export const move = (input: Input, index: number): void => {
  const target = Math.max(0, Math.min(input.plainText.length, index))
  if (target === 0) {
    input.cursorOffset = 0
    return
  }
  input.gotoBufferEnd()
  if (target === input.plainText.length) return
  let low = 0
  let high = input.cursorOffset
  // Wide graphemes occupy several columns. The last column giving the same
  // prefix is their boundary; never place the cursor inside a grapheme.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (input.editBuffer.getTextRange(0, middle).length <= target) low = middle
    else high = middle - 1
  }
  input.cursorOffset = low
}
