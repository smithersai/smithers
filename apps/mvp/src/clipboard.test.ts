import { Effect } from "effect"
import { expect, test } from "vitest"
import { Clipboard, ClipboardRefused } from "./clipboard.vibe"

const write = (text: string, writeText: (text: string) => Promise<void>) =>
  Effect.flatMap(Clipboard, clipboard => clipboard.write(text)).pipe(Effect.provide(Clipboard.layer(writeText)))

test("the clipboard writes the original text through the host", async () => {
  const writes: Array<string> = []
  const text = "first line\nsecond line"
  await Effect.runPromise(write(text, async received => { writes.push(received) }))
  expect(writes).toEqual([text])
})

test.each([
  ["rejection", () => Promise.reject(new Error("permission denied"))],
  ["synchronous refusal", () => { throw new Error("clipboard unavailable") }],
] as const)("the clipboard reports a %s as ClipboardRefused", async (_kind, writeText) => {
  const refusal = await Effect.runPromise(Effect.flip(write("copy me", writeText)))
  expect(refusal).toBeInstanceOf(ClipboardRefused)
  expect(refusal._tag).toBe("ClipboardRefused")
})
