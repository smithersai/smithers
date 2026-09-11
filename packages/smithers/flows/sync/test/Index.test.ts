/**
 * The package barrel. Every consumer imports through it, so its namespace
 * re-exports are part of the public contract: a renamed or dropped module here
 * breaks callers without any single module's own tests noticing.
 */
import { describe, expect, it } from "vitest"
import * as Sync from "../src/index.ts"

describe("@smthrs/sync barrel", () => {
  it("re-exports every module as its own namespace", () => {
    expect(Object.keys(Sync).sort()).toEqual([
      "BranchCommands",
      "BranchIds",
      "BranchPresence",
      "BranchProjection",
      "BranchProtocol",
      "BranchRpcs",
      "BranchServer",
      "BranchShare",
      "RunCatalog",
      "SyncAuth",
      "SyncClient",
      "SyncError",
      "SyncPrincipal",
      "SyncProtocol",
      "SyncRpcs",
      "SyncServer",
      "WorkspaceShare"
    ])
  })

  it("re-exports the same module objects the deep imports resolve to", async () => {
    expect(Sync.SyncError).toBe(await import("../src/SyncError.ts"))
    expect(Sync.SyncProtocol).toBe(await import("../src/SyncProtocol.ts"))
    expect(Sync.SyncRpcs).toBe(await import("../src/SyncRpcs.ts"))
    expect(Sync.RunCatalog).toBe(await import("../src/RunCatalog.ts"))
    expect(Sync.SyncServer).toBe(await import("../src/SyncServer.ts"))
    expect(Sync.SyncClient).toBe(await import("../src/SyncClient.ts"))
    expect(Sync.BranchProtocol).toBe(await import("../src/BranchProtocol.ts"))
    expect(Sync.BranchProjection).toBe(await import("../src/BranchProjection.ts"))
    expect(Sync.BranchShare).toBe(await import("../src/BranchShare.ts"))
    expect(Sync.BranchPresence).toBe(await import("../src/BranchPresence.ts"))
    expect(Sync.BranchCommands).toBe(await import("../src/BranchCommands.ts"))
    expect(Sync.BranchRpcs).toBe(await import("../src/BranchRpcs.ts"))
    expect(Sync.BranchServer).toBe(await import("../src/BranchServer.ts"))
    expect(Sync.BranchIds).toBe(await import("../src/BranchIds.ts"))
    expect(Sync.WorkspaceShare).toBe(await import("../src/WorkspaceShare.ts"))
    expect(Sync.SyncPrincipal).toBe(await import("../src/SyncPrincipal.ts"))
    expect(Sync.SyncAuth).toBe(await import("../src/SyncAuth.ts"))
  })

  it("maps a branch onto exactly one journal run, reversibly", () => {
    const branchId = "live-branch" as Sync.BranchProtocol.BranchId
    expect(Sync.BranchProtocol.branchOfRunId(Sync.BranchProtocol.branchRunId(branchId))).toBe(branchId)
    expect(Sync.BranchProtocol.branchOfRunId("flows/engine/run-1" as never)).toBeNull()
  })

  it("keeps the service namespaces' constructor conventions distinct", () => {
    expect(typeof Sync.SyncServer.make).toBe("function")
    expect(typeof Sync.SyncServer.makeNoop).toBe("function")
    expect(typeof Sync.SyncClient.makeNoop).toBe("function")
    expect(typeof Sync.RunCatalog.make).toBe("function")
    expect(Sync.SyncServer.makeNoop).not.toBe(Sync.SyncClient.makeNoop)
  })

  it("names every service tag after its module", () => {
    const tags = {
      BranchCommands: Sync.BranchCommands.BranchCommands,
      BranchIds: Sync.BranchIds.BranchIds,
      BranchPresence: Sync.BranchPresence.BranchPresence,
      BranchShare: Sync.BranchShare.BranchShare,
      RunCatalog: Sync.RunCatalog.RunCatalog,
      SyncClient: Sync.SyncClient.SyncClient,
      SyncServer: Sync.SyncServer.SyncServer,
      WorkspaceShare: Sync.WorkspaceShare.WorkspaceShare
    }
    for (const [module, tag] of Object.entries(tags)) expect(tag.key).toBe(`@smthrs/sync/${module}`)
  })

  it("keeps the deprecated Sync alias bound to the SyncClient tag", () => {
    expect(Sync.SyncClient.Sync).toBe(Sync.SyncClient.SyncClient)
  })

  it("exposes the tagged error classes with their canonical tags", () => {
    expect(new Sync.SyncError.SyncError({ code: "unknown", message: "x" })._tag).toBe(
      "@smthrs/sync/SyncError"
    )
    expect(
      new Sync.SyncError.SyncGapError({ runId: "run" as never, expectedFrom: 1, receivedFrom: 3 } as never)._tag
    ).toBe("@smthrs/sync/SyncGapError")
  })
})
