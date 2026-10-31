import { expect, test } from "vitest"
import { contributionViewer, hereOf, ownRepository } from "./viewer"

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

// Will's VibeLang journey, 2026-10-31: a plugin's repository view (Factory's For you, `minimum: "maintainer"`) was gated
// by the session's role on the deployment's own repository, so a Maintainer of smithersai/vibelang who is a Member of
// smithersai/smithers saw an empty page, and the reverse would show a Guest a maintainer's view.
test("a repository's plugin contributions are gated by the role on that repository, not the deployment's own", () => {
  const member = { status: "signed_in" as const, role: "member" as const }
  expect(contributionViewer(member, undefined, { answer: { role: "maintainer", own: false } }))
    .toEqual({ signedIn: true, role: "maintainer" })
  const admin = { status: "signed_in" as const, role: "admin" as const }
  expect(contributionViewer(admin, undefined, { answer: { role: "guest", own: false } })).toEqual({ signedIn: true, role: "guest" })
  // Before ChatApi answers for the repository, nothing role-gated shows there.
  expect(contributionViewer(admin, undefined, { answer: undefined })).toEqual({ signedIn: true, role: null })
  expect(contributionViewer({ status: "signed_out", role: null }, undefined, { answer: { role: "admin", own: true } }))
    .toEqual({ signedIn: false, role: null })
  // Off a repository, the session's role.
  expect(contributionViewer(member, undefined, undefined)).toEqual({ signedIn: true, role: "member" })
})
