import { decodeStored } from "./sealed"

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const numericID = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const login = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9-]{1,39}$/.test(value)
export interface LegacyIdentityBinding { readonly id: number; readonly login: string; readonly boundAt: string }

/** Only a verified account row AND its current alias round-trip can bind login-addressed legacy state. */
export class IdentityInventory {
  private readonly accounts = new Map<number, LegacyIdentityBinding>()
  private readonly aliases = new Map<string, number>()
  private readonly ambiguousAccounts = new Set<number>()
  private readonly ambiguousAliases = new Set<string>()
  private readonly counts: Record<string, number> = {}
  private add(name: string, count = 1) { this.counts[name] = (this.counts[name] ?? 0) + count }
  include(snapshot: { entries: Array<[string, unknown]>; alarm: number | null }, firstPage = true) {
    if (firstPage) this.add("objects")
    this.add("rows", snapshot.entries.length)
    if (firstPage && snapshot.alarm !== null) this.add("alarms")
    for (const [key, encoded] of snapshot.entries) {
      const raw = decodeStored(encoded), value = object(raw)
      if (key.startsWith("account:")) {
        this.add("accountRows")
        const id = Number(key.slice(8))
        if (!/^account:[1-9][0-9]*$/.test(key) || !numericID(id) || value?.id !== id || !login(value.login) || typeof value.boundAt !== "string" || !Number.isFinite(Date.parse(value.boundAt))) { this.add("invalidAccountRows"); continue }
        if (this.accounts.has(id)) this.ambiguousAccounts.add(id)
        this.accounts.set(id, { id, login: value.login, boundAt: value.boundAt })
      } else if (key.startsWith("loginid:")) {
        this.add("loginAliasRows")
        const name = key.slice(8)
        if (!login(name) || name !== name.toLowerCase() || !numericID(raw)) { this.add("invalidAliasRows"); continue }
        if (this.aliases.has(name)) this.ambiguousAliases.add(name)
        this.aliases.set(name, raw)
      } else {
        const kind = ["allow", "deny", "req", "oauth", "ghtoken", "ghrefreshclaim", "ghrefreshstate", "cloudtoken", "cloudstate", "handoff", "watched", "repocandidates", "audit", "ratelimit"].find(prefix => key.startsWith(prefix + ":"))
        this.add(kind ? `${kind}Rows` : "unclassifiedRows")
      }
    }
  }
  bindings(): ReadonlyMap<string, LegacyIdentityBinding> {
    const verified = new Map<string, LegacyIdentityBinding>()
    const historicalOwners = new Map<string, number>()
    for (const account of this.accounts.values()) historicalOwners.set(account.login.toLowerCase(), (historicalOwners.get(account.login.toLowerCase()) ?? 0) + 1)
    for (const [name, id] of this.aliases) {
      const account = this.accounts.get(id)
      if (account && !this.ambiguousAliases.has(name) && !this.ambiguousAccounts.has(id) && account.login.toLowerCase() === name && historicalOwners.get(name) === 1) verified.set(name, account)
    }
    return verified
  }
  summary() {
    const verified = this.bindings().size
    return { ...this.counts, verifiedLegacyIdentityBindings: verified, unresolvedAliases: this.aliases.size - verified,
      accountsWithoutCurrentAlias: this.accounts.size - verified, ambiguousAccountIDs: this.ambiguousAccounts.size, ambiguousAliases: this.ambiguousAliases.size,
      verifiedCanonicalIdentityMappings: 0 }
  }
}
