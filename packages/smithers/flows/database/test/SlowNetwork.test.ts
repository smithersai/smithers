/**
 * The slow network suites put in front of a test database: every round trip
 * pays the delay twice, and closing the scope closes the proxy.
 */
import * as Pg from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Context, Duration, Effect, Exit, Layer, Scope } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { connect } from "node:net"
import { PostgresDatabase } from "../src/index.ts"
import { endpoint } from "../src/internal/SlowNetworkTarget.ts"
import * as SlowNetwork from "../src/test/SlowNetwork.ts"
import { listening } from "./harness/listening.ts"

const url = process.env.SMITHERS_TEST_PG_URL

describe("SlowNetwork", () => {
  it("resolves PostgreSQL's default port for a URL that names none", () => {
    expect(endpoint("postgres://smithers@localhost/smithers")).toEqual({ host: "localhost", port: 5432 })
  })

  it("preserves an explicit upstream host and port", () => {
    expect(endpoint("postgres://smithers@localhost:6543/smithers")).toEqual({ host: "localhost", port: 6543 })
  })

  it.live.skipIf(url === undefined)(
    "adds its delay to every round trip, and closes with its scope",
    () =>
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const slow = yield* Scope.provide(SlowNetwork.proxy(url!, { delayMs: 25 }), scope)
        const sql = Context.get(
          yield* Layer.buildWithScope(
            PostgresDatabase.layer({ url: slow, driver: Pg, readOnly: true, postgres: { maxConnections: 1 } }),
            scope
          ),
          SqlClient
        )
        expect(yield* sql<{ readonly one: number }>`SELECT 1 AS one`).toEqual([{ one: 1 }])
        // A connection that ends rather than drops ends at the far side too, after the delay.
        const proxied = new URL(slow)
        yield* Effect.callback<void>((resume) => {
          const socket = connect({ host: proxied.hostname, port: Number(proxied.port) }, () => socket.end())
          socket.resume()
          socket.once("close", () => resume(Effect.void))
        })
        // A lone statement is BEGIN, the schema, the statement and COMMIT: four round trips.
        const [elapsed] = yield* Effect.timed(sql`SELECT 1`)
        expect(Duration.toMillis(elapsed)).toBeGreaterThanOrEqual(4 * 2 * 25)
        yield* Scope.close(scope, Exit.void)
        expect(yield* Effect.promise(() => listening(slow))).toBe(false)
      })
  )
})
