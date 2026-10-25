import { expect, test } from "vitest"
import { hereOf, ownRepository } from "./viewer"

// Who the person is on the routed repository (decision 0079), from sign-in and ChatApi's answer for it.

test("the role is ChatApi's answer for the repository; none signed out or before it answers", () => {
  const signedIn = { status: "signed_in" as const, role: "admin" as const }
  expect(hereOf(signedIn, undefined, { role: "guest", own: false })).toEqual({ signedIn: true, role: "guest", own: false })
  // The session's role on the deployment's own repository never stands in for an answer.
  expect(hereOf(signedIn, undefined, undefined)).toEqual({ signedIn: true, role: null, own: false })
  expect(hereOf({ status: "signed_out", role: null }, { role: "member" }, { role: "member", own: true })).toEqual({
    signedIn: false,
    role: null,
    own: true,
  })
  // Offline, the session this device confirmed is still signed in, with the answer this tab had.
  expect(hereOf({ status: "unreachable", role: null }, { role: "member" }, { role: "maintainer", own: true })).toEqual({
    signedIn: true,
    role: "maintainer",
    own: true,
  })
})

test("the deployment's own repository only once ChatApi says so: unknown fails closed", () => {
  expect(ownRepository(undefined)).toBe(false)
  expect(ownRepository({ role: "admin", own: false })).toBe(false)
  expect(ownRepository({ role: null, own: true })).toBe(true)
})
