import { describe, expect, it } from "@effect/vitest"
import * as ReleasePolicy from "../src/internal/ReleasePolicy.ts"
import * as UnsupportedBackend from "../src/UnsupportedBackend.ts"

/**
 * CLI notices for legacy environment names. Production selects PostgreSQL
 * through SMITHERS_POSTGRES_URL; SMITHERS_TEST_PG_URL selects PostgreSQL only
 * in TestDatabase. These assertions pin the notice, not database selection.
 */

describe("legacy database configuration notices", () => {
  it.each([
    "SMITHERS_TEST_PG_URL",
    "SMITHERS_POSTGRES_MAX_CONNECTIONS"
  ])("announces %s", (name) => {
    expect(UnsupportedBackend.ignoredNames({ [name]: "postgres://localhost/smithers" })).toEqual([name])
    expect(UnsupportedBackend.ignoredNotice(name)).toBe(
      `ignored: ${name} has no effect in ${ReleasePolicy.releaseVersion} (use SMITHERS_POSTGRES_URL to select PostgreSQL)`
    )
  })

  it("announces every matching name once, in a stable order", () => {
    expect(UnsupportedBackend.ignoredNames({
      SMITHERS_POSTGRES_URL: "postgres://localhost/smithers",
      SMITHERS_TEST_PG_URL: "postgres://localhost/test",
      SMITHERS_POSTGRES_MAX_CONNECTIONS: "10",
      SMITHERS_REMOTE: "http://localhost:3000",
      PATH: "/usr/bin"
    })).toEqual([
      "SMITHERS_POSTGRES_MAX_CONNECTIONS",
      "SMITHERS_TEST_PG_URL"
    ])
  })

  it("announces nothing about a supported configuration name", () => {
    expect(
      UnsupportedBackend.ignoredNames({
        SMITHERS_BACKEND: "sqlite",
        SMITHERS_POSTGRES_URL: "postgres://localhost/db",
        SMITHERS_POSTGRES_SCHEMA: "flows",
        SMITHERS_REMOTE: "http://x"
      })
    ).toEqual([])
  })

  it("does not announce native Go fixture programs as legacy database configuration", () => {
    expect(UnsupportedBackend.ignoredNames({
      SMITHERS_POSTGRES_TEST_BIN: "/usr/lib/postgresql/18/bin",
      SMITHERS_POSTGRES_POOL_MAX: "10"
    })).toEqual(["SMITHERS_POSTGRES_POOL_MAX"])
  })

  /**
   * The contract lists `SMITHERS_POSTGRES_*`, not every name that starts with
   * those letters. A prefix test without the separator claims rc.0 ignores
   * `SMITHERS_POSTGRESQL_URL`, a name it never read, and the notice would
   * describe a decision nobody made.
   */
  it("announces nothing about a name outside the SMITHERS_POSTGRES_ family", () => {
    expect(UnsupportedBackend.ignoredNames({ SMITHERS_POSTGRESQL_URL: "postgres://localhost/smithers" }))
      .toEqual([])
    expect(UnsupportedBackend.ignoredNames({ SMITHERS_POSTGRESTS: "1" })).toEqual([])
  })

  it("treats an exported-but-blank name as unset", () => {
    expect(UnsupportedBackend.ignoredNames({ SMITHERS_POSTGRES_URL: "" })).toEqual([])
    expect(UnsupportedBackend.ignoredNames({ SMITHERS_POSTGRES_URL: undefined })).toEqual([])
    expect(UnsupportedBackend.ignoredNames({})).toEqual([])
  })
})
