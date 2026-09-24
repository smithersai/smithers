import { expect, test } from "bun:test"
import { encodeStored } from "../../src/SealedSnapshot"
import { IdentityInventory } from "./identity"

const snapshot = (entries: Array<[string, unknown]>) => ({ alarm: null, entries: entries.map(([key, value]): [string, unknown] => [key, encodeStored(value)]) })
const account = (id: number, login: string) => ({ id, login, boundAt: "2026-09-24T00:00:00Z" })
test("identity mappings require numeric provider ID, account provenance and the current alias round trip", () => {
  const inventory = new IdentityInventory()
  inventory.include(snapshot([
    ["account:10", account(10, "Current")], ["loginid:current", 10],
    ["account:11", account(11, "Reused")], ["loginid:reused", 12],
    ["account:12", account(12, "Reused")],
    ["account:13", account(99, "wrong")], ["loginid:wrong", 13],
    ["account:14", { id: 14, login: "missing-time" }], ["loginid:missing-time", 14],
    ["loginid:unbound", 15], ["loginid:textid", "10"],
    ["ghtoken:id:10", { accessToken: "fixture-only-secret" }], ["oauth:fixture", { nonce: "fixture-only-nonce" }]
  ]))
  expect([...inventory.bindings()].map(([name, row]) => [name, row.id])).toEqual([["current", 10]])
  expect(inventory.summary()).toMatchObject({ verifiedLegacyIdentityBindings: 1, invalidAccountRows: 2, invalidAliasRows: 1, unresolvedAliases: 4, accountsWithoutCurrentAlias: 2, verifiedCanonicalIdentityMappings: 0 })
  expect(JSON.stringify(inventory.summary())).not.toContain("fixture-only")
  expect(JSON.stringify(inventory.summary())).not.toContain('"Current"')
})
test("duplicate numeric accounts or alias rows cannot produce a verified binding", () => {
  const inventory = new IdentityInventory()
  inventory.include(snapshot([["account:10", account(10, "owner")], ["loginid:owner", 10]]))
  inventory.include(snapshot([["account:10", account(10, "owner")], ["loginid:owner", 10]]))
  expect(inventory.bindings().size).toBe(0)
  expect(inventory.summary()).toMatchObject({ ambiguousAccountIDs: 1, ambiguousAliases: 1 })
})
