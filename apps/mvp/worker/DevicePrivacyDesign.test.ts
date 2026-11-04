import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (path: string) => readFileSync(join(root, path), "utf8")
const decision = "effectscript-11 decision, 2026-11-02: any session end (expiry, revocation, account change) wipes all device private data, like sign-out; seal-and-keep rejected; drafts/outbox wiped with the discarded count shown. Why: privacy over convenience, but no surprise work loss."

test("revision 17 and its prerequisite rows are published without private review paths", () => {
  const design = read("docs/design/device-privacy/design.md")
  expect(design).toContain("Revision 17 is the last design-only revision")
  expect(design).toContain("3 prerequisites (r17)")
  expect(design).toContain("Astra on the model (revision 17, in place)")
  expect(design).not.toMatch(/\/Users\/|\/private\/tmp\/|scratchpad|\.\.\/|FINAL(?:\.rev\d+)?\.md/)
  expect(design).not.toMatch(/(?:r\d+-astra|reviewfinal\d*-astra)\.log/)
})

test("the decision states the exact boundary, refinement, retention and inert alert", () => {
  const text = read("docs/decisions/0151-every-session-end-wipes-the-device.md")
  expect(text).toContain(decision)
  expect(text).toContain("2026-11-03")
  expect(text).toContain("a server-side failure to verify a live row's cookie is inconclusive, not an end")
  expect(text).toContain("No non-test code deletes people")
  expect(text).toContain("Receipts on account deletion are unproven")
  expect(text).toContain("Account deletion stays open")
  expect(text).toContain("30 days")
  expect(text).toContain("400 days")
  expect(text).toContain("SessionEndWriters.test.ts")
  expect(text).toContain("cannot catch an allowed writer firing wrongly")
  for (const path of ["docs/observability.md", "docs/features/sign-in.md", "docs/decisions/0151-every-session-end-wipes-the-device.md"]) {
    const doc = read(path)
    expect(doc, path).toMatch(/cookie_rejected[\s\S]*inert/)
    expect(doc, path).toContain("neither alerting nor a safety control")
    expect(doc, path).not.toMatch(/Will(?:'|’)s ruling/i)
  }
})
