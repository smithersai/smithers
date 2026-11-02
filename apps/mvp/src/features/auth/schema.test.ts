import { Schema } from "effect"
import { expect, test } from "vitest"
import { SessionState } from "./schema"

const decode = Schema.decodeUnknownSync(SessionState)

// Device privacy (devpriv FINAL step 1): a signed-in answer may say until when the session is live and the server's
// clock; an answer from a build before it still reads, and so does one with a session that never ends.
test("a signed-in answer reads with its session's end and the server's now, or without them", () => {
  const signedIn = { signedIn: true, personId: "p1", login: "octocat", role: "member", hostedModel: false }
  expect(decode({ ...signedIn, expiresAt: 1_800_000_000_000, serverNow: 1_799_000_000_000 })).toEqual({
    ...signedIn,
    expiresAt: 1_800_000_000_000,
    serverNow: 1_799_000_000_000,
  })
  expect(decode({ ...signedIn, serverNow: 1_799_000_000_000 })).toEqual({ ...signedIn, serverNow: 1_799_000_000_000 })
  expect(decode(signedIn)).toEqual(signedIn)
  expect(() => decode({ ...signedIn, expiresAt: "tomorrow" })).toThrow()
})
