import { Schema } from "effect"
import { expect, test } from "vitest"
import { SessionState } from "./schema"

const decode = Schema.decodeUnknownSync(SessionState)
test("the opaque session tag is optional and survives response decoding", () => {
  const signed = { signedIn: true, login: "octocat", role: "member" }
  expect(decode(signed)).toEqual(signed)
  const session = "0123456789abcdef0123456789abcdef"
  expect(decode({ ...signed, session })).toEqual({ ...signed, session })
  expect(() => decode({ ...signed, session: 42 })).toThrow()
})

test("the complete response contract admits the identity-free stale answer", async () => {
  const { SessionResponse } = await import("./schema")
  expect(Schema.decodeUnknownSync(SessionResponse)({ credential: "stale" })).toEqual({ credential: "stale" })
})
