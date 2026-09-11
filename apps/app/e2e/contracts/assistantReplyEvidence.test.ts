import { describe, expect, test } from "bun:test"
import { assistantReplyEvidence } from "./assistantReplyEvidence"
import type { TranscriptBubble } from "./assistantReplyEvidence"

const PROMPT = "Reply with the single word: ok"

const bubble = (
  role: string,
  text: string,
  pending = false
): TranscriptBubble => ({ role, text, pending })

// What the app renders before any turn: an initialization bubble and a
// completed auth bubble, both assistant, both non-empty, neither pending.
const boot: ReadonlyArray<TranscriptBubble> = [
  bubble("assistant", "Smithers initialized"),
  bubble("assistant", "Sign in to use chat.")
]

describe("assistantReplyEvidence", () => {
  test("rejects a no-op send that left the boot transcript untouched", () => {
    expect(assistantReplyEvidence(boot, boot, PROMPT)).toBeUndefined()
  })

  test("rejects a submitted turn that has drawn no reply yet", () => {
    const after = [...boot, bubble("user", PROMPT)]
    expect(assistantReplyEvidence(boot, after, PROMPT)).toBeUndefined()
  })

  test("rejects a reply that is still streaming", () => {
    const after = [...boot, bubble("user", PROMPT), bubble("assistant", "o", true)]
    expect(assistantReplyEvidence(boot, after, PROMPT)).toBeUndefined()
  })

  test("rejects an assistant bubble that predates the submitted turn", () => {
    const after = [...boot, bubble("user", PROMPT)]
    expect(assistantReplyEvidence(boot, after, PROMPT)?.text).toBeUndefined()
  })

  test("accepts a completed reply that follows the submitted turn", () => {
    const after = [...boot, bubble("user", PROMPT), bubble("assistant", "ok")]
    expect(assistantReplyEvidence(boot, after, PROMPT)?.text).toBe("ok")
  })

  test("binds the reply to this send when the same prompt was sent before", () => {
    const before = [...boot, bubble("user", PROMPT), bubble("assistant", "ok")]
    const after = [...before, bubble("user", PROMPT), bubble("assistant", "ok again")]
    expect(assistantReplyEvidence(before, after, PROMPT)?.text).toBe("ok again")
  })

  test("rejects a second send that only re-rendered the earlier reply", () => {
    const before = [...boot, bubble("user", PROMPT), bubble("assistant", "ok")]
    expect(assistantReplyEvidence(before, before, PROMPT)).toBeUndefined()
  })
})
