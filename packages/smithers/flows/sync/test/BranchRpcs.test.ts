/**
 * What the branch wire contract depends on.
 *
 * flows-sync/maintainability/1: `BranchRpcs` is the group a remote client
 * builds `RpcClient.make` from, yet it imported `BranchCommands` and
 * `BranchPresence` for four payload schemas, so the wire contract reached the
 * command ledger (and through it the `Journal` service) and the presence
 * registry. The request schemas now live in `BranchProtocol` beside every
 * other branch wire shape, and the group and the services both name them
 * there. This walks the relative import graph from the group and pins that,
 * without evaluating a module.
 */
import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchRpcs from "../src/BranchRpcs.ts"

const src = new URL("../src/", import.meta.url)

/** Every module specifier one source file imports or re-exports, at value or type level. */
const specifiers = (file: URL): ReadonlyArray<string> =>
  Array.from(
    readFileSync(file, "utf8").matchAll(/^(?:import|export)\b[^"]*?\bfrom "([^"]+)"/gmu),
    ([, specifier]) => specifier!
  )

/** Every source file reachable from `entry` through relative imports, relative to `src/`. */
const reachable = (entry: string): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const visit = (file: URL): void => {
    const key = fileURLToPath(file).slice(fileURLToPath(src).length)
    if (seen.has(key)) return
    seen.add(key)
    for (const specifier of specifiers(file)) {
      if (specifier.startsWith(".")) visit(new URL(specifier, file))
    }
  }
  visit(new URL(entry, src))
  return [...seen].sort()
}

describe("BranchRpcs", () => {
  it("imports only the wire vocabulary", () => {
    expect(specifiers(new URL("BranchRpcs.ts", src)).filter((specifier) => specifier.startsWith("."))).toEqual([
      "./BranchProtocol.ts",
      "./SyncError.ts",
      "./SyncRpcs.ts"
    ])
  })

  it("reaches no branch service and never the journal service", () => {
    const files = reachable("BranchRpcs.ts")
    expect(files).toContain("BranchProtocol.ts")
    for (const service of ["BranchCommands.ts", "BranchPresence.ts", "BranchShare.ts", "internal/Admission.ts"]) {
      expect(files).not.toContain(service)
    }
    const external = files.flatMap((file) => specifiers(new URL(file, src))).filter((specifier) =>
      !specifier.startsWith(".")
    )
    expect(external).not.toContain("@smthrs/journal")
    expect(external).not.toContain("effect/Semaphore")
  })

  it("carries the request schemas the branch services take, not copies of them", () => {
    const payload = (tag: string) => BranchRpcs.BranchRpcs.requests.get(tag)?.payloadSchema
    expect(payload("Branch.Submit")).toBe(BranchProtocol.SubmitRequest)
    expect(payload("Branch.Announce")).toBe(BranchProtocol.Announcement)
    expect(payload("Branch.Leave")).toBe(BranchProtocol.LeaveRequest)
    expect(payload("Branch.Roster")).toBe(BranchProtocol.RosterRequest)
    expect(payload("Branch.WatchRoster")).toBe(BranchProtocol.RosterRequest)
  })
})
