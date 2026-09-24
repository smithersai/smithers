import { decodeStored } from "./sealed"

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Content-free counts only. Owner labels stay in memory, never in the report. */
export class Inventory {
  readonly counts: Record<string, number> = {}
  private readonly logins = new Set<string>()
  private readonly journalOwners = new Set<string>()
  private add(name: string, count = 1) { this.counts[name] = (this.counts[name] ?? 0) + count }
  private owner(value: unknown) { if (typeof value === "string" && value.length > 0) this.logins.add(value) }
  include(binding: string, snapshot: { entries: Array<[string, unknown]>; alarm: number | null; migrationContext?: { modelVaultKey: string | null } }, capturedAt: string) {
    this.add("objects")
    this.add("rows", snapshot.entries.length)
    if (snapshot.alarm !== null) this.add("alarms")
    if (!snapshot.entries.length) this.add("emptyObjects")
    for (const [key, encoded] of snapshot.entries) {
      const raw = decodeStored(encoded), value = record(raw)
      if (binding === "MODEL_VAULTS" && key === "model-vault:v1") {
        this.add("vaultDocuments")
        if (!value || value.version !== 1 || typeof value.login !== "string" || !Array.isArray(value.entries) || !Array.isArray(value.receipts)) {
          this.add("unclassifiedRows"); continue
        }
        this.owner(value.login)
        this.add("vaultEntries", value.entries.length)
        this.add("vaultReceipts", value.receipts.length)
        const sealedEntries = value.entries.filter(entry => record(record(entry)?.sealed) !== undefined).length
        this.add("vaultSealedEntries", sealedEntries)
        if (sealedEntries > 0 && !snapshot.migrationContext?.modelVaultKey) this.add("vaultDocumentsMissingRecoveryKey")
      } else if (binding === "TURN_CANCELS" && key === "state") {
        this.add("turnStates")
        this.owner(value?.owner)
        if (!value || !["active", "cancelled", "settled"].includes(String(value.state)) || typeof value.at !== "number") this.add("unclassifiedRows")
        else if (value.state === "active") this.add(Date.parse(capturedAt) - value.at > 600_000 ? "staleActiveTurns" : "activeTurns")
        else this.add(value.state === "cancelled" ? "cancelledTurns" : "settledTurns")
      } else if (binding === "TURN_CANCELS" && key === "turn-journal:v1:head") {
        this.add("journalHeads")
        const acceptance = record(value?.acceptance)
        const owner = value?.retired === true ? value.ownerHash : acceptance?.ownerHash
        if (typeof owner === "string") this.journalOwners.add(owner)
        if (value?.retired === true) this.add("journalRetirements")
        else if (value?.terminal === true) this.add("journalTerminalHeads")
        else if (value?.terminal === false) this.add("journalOpenHeads")
        else this.add("unclassifiedRows")
      } else if (binding === "TURN_CANCELS" && key.startsWith("turn-journal:v1:batch:")) {
        this.add("journalBatches")
        if (Array.isArray(value?.frames)) this.add("journalFrames", value.frames.length)
        else this.add("unclassifiedRows")
      } else if (binding === "GATEWAY_SESSIONS" && key.startsWith("repository-setup:request:")) {
        this.add("setupRequests")
        if (value?.result !== undefined) this.add("setupResultRecords")
        else this.add("setupUnfinishedRecords")
        if (typeof value?.runId === "string") this.add("setupRunBindings")
        if (typeof value?.observationError === "string") this.add("setupObservationErrors")
      } else if (binding === "GATEWAY_SESSIONS" && key === "repository-setup:pending") {
        this.owner(value?.login)
        const requests = record(value?.requests)
        if (!requests) this.add("unclassifiedRows")
        else {
          this.add("setupQueuedRequests", Object.keys(requests).length)
          this.add("setupExpiredQueueEntries", Object.values(requests).filter(at => typeof at === "number" && at < Date.parse(capturedAt)).length)
        }
      } else if (binding === "GATEWAY_SESSIONS" && key.startsWith("repository-setup:current:")) this.add("setupPointers")
      else if (binding === "GATEWAY_SESSIONS" && key.startsWith("gateway:")) this.add("gatewayBindings")
      else if (binding === "RECOMMEND_LOG" && key.startsWith("row:")) this.add("recommendationRows")
      else if (binding === "CLIENT_ERRORS" && key.startsWith("row:")) this.add("clientErrorRows")
      else if (binding === "TURN_LIMITS") this.add("rateLimitRows")
      else if (key === "seq" && ["CLIENT_ERRORS", "RECOMMEND_LOG"].includes(binding)) this.add("logSequenceRows")
      else this.add("unclassifiedRows")
    }
  }
  summary() { return { ...this.counts, distinctLegacyLoginLabels: this.logins.size, distinctJournalOwnerHashes: this.journalOwners.size,
    verifiedCanonicalIdentityMappings: 0 } }
}
