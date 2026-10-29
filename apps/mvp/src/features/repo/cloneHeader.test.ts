import { expect, test } from "vitest"
import { cloneHeaderOf } from "./cloneHeader"
import { MEMBERS_CLONE, SIGN_IN_TO_CLONE } from "./contract"
import type { Header } from "./view"

for (const kind of ["ready", "cloning", "missing", "unavailable", "unknown"] as const) test(`${kind} doesn't offer a new clone`, () => {
  const header = { kind }
  expect(cloneHeaderOf(header, true, { role: "guest", own: false })).toBe(header)
})
for (const header of [{ kind: "clone" }, { kind: "refused", text: "Try again" }] satisfies Header[]) {
  test(`${header.kind}: wait for session and repository authority`, () => {
    expect(cloneHeaderOf(header, null, { role: "admin", own: true })).toEqual({ kind: "unknown" })
    expect(cloneHeaderOf(header, true, undefined)).toEqual({ kind: "unknown" })
    expect(cloneHeaderOf(header, true, { role: null, own: false, failure: "unavailable" })).toEqual(header.kind === "refused" ? { ...header, retry: false } : { kind: "unknown" })
    expect(cloneHeaderOf(header, false, { role: "admin", own: true })).toEqual({ kind: "sign_in", text: SIGN_IN_TO_CLONE })
  })
  for (const role of [null, "guest"] as const) test(`${header.kind}: ${role} reads without Clone or Try again`, () => {
    for (const own of [false, true]) expect(cloneHeaderOf(header, true, { role, own })).toEqual({ kind: "refused", text: MEMBERS_CLONE, retry: false })
  })
  for (const role of ["member", "maintainer", "admin"] as const) test(`${header.kind}: ${role} may clone here`, () => {
    for (const own of [false, true]) expect(cloneHeaderOf(header, true, { role, own })).toBe(header)
  })
}
