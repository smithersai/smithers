import { expect, test } from "bun:test"
import { encodeStored } from "../../src/SealedSnapshot"
import { Inventory } from "./inventory"

test("inventory separates object presence, credential rows, live work and journals without content", () => {
  const report = new Inventory()
  const at = "2026-09-24T18:00:00.000Z", now = Date.parse(at)
  const include = (binding: string, values: Record<string, unknown>) => report.include(binding, {
    entries: Object.entries(values).map(([key, value]) => [key, encodeStored(value)]), alarm: null
  }, at)
  include("MODEL_VAULTS", {})
  include("MODEL_VAULTS", { "model-vault:v1": { version: 1, login: "private-owner", entries: [{ sealed: { ciphertext: "secret" } }, { sealed: null }], receipts: ["receipt"] } })
  include("TURN_CANCELS", { state: { state: "active", at: now - 700_000, owner: "private-owner" },
    "turn-journal:v1:head": { acceptance: { ownerHash: "private-hash" }, terminal: true },
    "turn-journal:v1:batch:0": { frames: [{ text: "private-transcript" }] } })
  include("TURN_CANCELS", { state: { state: "active", at: now } })
  include("TURN_CANCELS", { "turn-journal:v1:head": { retired: true, ownerHash: "private-hash" } })
  include("GATEWAY_SESSIONS", { "repository-setup:request:one": { runId: "private-run" },
    "repository-setup:request:two": { result: {} }, "repository-setup:pending": { login: "private-owner", requests: { one: now + 5000, two: now - 1 } } })
  expect(report.summary()).toMatchObject({ objects: 6, emptyObjects: 1, vaultDocuments: 1, vaultSealedEntries: 1,
    vaultEntries: 2, vaultReceipts: 1, activeTurns: 1, staleActiveTurns: 1, journalHeads: 2, journalRetirements: 1,
    journalBatches: 1, journalFrames: 1, setupUnfinishedRecords: 1, setupResultRecords: 1, setupQueuedRequests: 2,
    setupExpiredQueueEntries: 1, distinctLegacyLoginLabels: 1, distinctJournalOwnerHashes: 1, verifiedCanonicalIdentityMappings: 0 })
  expect(JSON.stringify(report.summary())).not.toContain("private")
  expect(JSON.stringify(report.summary())).not.toContain("secret")
})
