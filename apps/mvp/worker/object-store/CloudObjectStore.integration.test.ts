import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import type { Actor } from "../Actor.vibe"
import { testFile } from "../test/harness.ts"
import { classifyExecutionTrust } from "../trust/ExecutionTrust.vibe"
import { getObject, listObjects, putObject, type R2ByteBacking } from "./CloudObjectStore.vibe"

const runtime = testFile("cloud_object_store_integration")
const POLICY = { admins: new Set(["roninjin10"]) }
const ADMIN: Actor = { subject: { kind: "person", id: "11111111-1111-4111-8111-111111111111" }, role: "admin", login: "roninjin10" }
const MALLORY: Actor = { subject: { kind: "person", id: "22222222-2222-4222-8222-222222222222" }, role: "guest", login: "mallory" }
const ALICE: Actor = { subject: { kind: "person", id: "33333333-3333-4333-8333-333333333333" }, role: "guest", login: "alice" }

const memoryR2 = (): R2ByteBacking => {
  const store = new Map<string, Uint8Array>()
  return {
    put: (key, bytes) =>
      Effect.sync(() => {
        store.set(key, new Uint8Array(bytes))
      }),
    get: (key) =>
      Effect.sync(() => {
        const found = store.get(key)
        return found === undefined ? Option.none() : Option.some(new Uint8Array(found))
      }),
  }
}

beforeEach(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${"11111111-1111-4111-8111-111111111111"}, ${1001}, ${"roninjin10"}) ON CONFLICT (id) DO NOTHING`
      yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${"22222222-2222-4222-8222-222222222222"}, ${1002}, ${"mallory"}) ON CONFLICT (id) DO NOTHING`
      yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${"33333333-3333-4333-8333-333333333333"}, ${1003}, ${"alice"}) ON CONFLICT (id) DO NOTHING`
    }),
  )
})

describe("CloudObjectStore Postgres + R2 integration", () => {
  test("stores, verifies SHA-256, lists, and reads trusted objects across namespaces", async () => {
    const r2 = memoryR2()
    const trusted = classifyExecutionTrust({ role: "maintainer", isDeploymentAdmin: true, sandboxAttested: false })
    const payload = new TextEncoder().encode(JSON.stringify({ overall: 96, categories: [] }))

    const stored = await runtime.runPromise(
      putObject(
        {
          owner: "smithersai",
          name: "smithers",
          isPublicRepo: true,
          namespace: "audit-report",
          key: "latest.json",
          bytes: payload,
          contentType: "application/json",
          trust: trusted,
          actor: ADMIN,
          policy: POLICY,
        },
        r2,
      ),
    )

    expect(stored.executionTrust).toBe("trusted_maintainer")
    expect(stored.gateEligible).toBe(true)
    expect(stored.key).toBe("latest.json")
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/)

    const listed = await runtime.runPromise(
      listObjects({
        owner: "smithersai",
        name: "smithers",
        isPublicRepo: true,
        namespace: "audit-report",
        actor: undefined,
        role: null,
        policy: POLICY,
      }),
    )
    expect(listed.length).toBe(1)
    expect(listed[0]?.sha256).toBe(stored.sha256)

    const fetched = await runtime.runPromise(
      getObject(
        {
          owner: "smithersai",
          name: "smithers",
          isPublicRepo: true,
          namespace: "audit-report",
          key: "latest.json",
          actor: undefined,
          role: null,
          policy: POLICY,
        },
        r2,
      ),
    )
    expect(new TextDecoder().decode(fetched.bytes)).toContain("\"overall\":96")
  })

  test("refuses untrusted cache poisoning and isolates untrusted audit-report and wiki writes", async () => {
    const r2 = memoryR2()
    const untrusted = classifyExecutionTrust({ role: "guest", isDeploymentAdmin: false, sandboxAttested: false })

    const cacheErr = await runtime.runPromise(
      Effect.flip(
        putObject(
          {
            owner: "smithersai",
            name: "smithers",
            isPublicRepo: true,
            namespace: "cache",
            key: "turbo/key-1",
            bytes: new TextEncoder().encode("poison"),
            contentType: "application/octet-stream",
            trust: untrusted,
            actor: MALLORY,
            policy: POLICY,
          },
          r2,
        ),
      ),
    )
    expect(cacheErr.code).toBe("untrusted_cache_write")

    const audit = await runtime.runPromise(
      putObject(
        {
          owner: "smithersai",
          name: "smithers",
          isPublicRepo: true,
          namespace: "audit-report",
          key: "latest.json",
          bytes: new TextEncoder().encode("{\"overall\":100}"),
          contentType: "application/json",
          trust: untrusted,
          actor: ALICE,
          policy: POLICY,
        },
        r2,
      ),
    )
    expect(audit.executionTrust).toBe("untrusted_contributor")
    expect(audit.gateEligible).toBe(false)
    expect(audit.key).toBe("untrusted/alice/latest.json")

    const wiki = await runtime.runPromise(
      putObject(
        {
          owner: "smithersai",
          name: "smithers",
          isPublicRepo: true,
          namespace: "wiki",
          key: "architecture.md",
          bytes: new TextEncoder().encode("# Proposed"),
          contentType: "text/markdown",
          trust: untrusted,
          actor: ALICE,
          policy: POLICY,
        },
        r2,
      ),
    )
    expect(wiki.gateEligible).toBe(false)
    expect(wiki.key).toBe("proposed/alice/architecture.md")
  })
})
