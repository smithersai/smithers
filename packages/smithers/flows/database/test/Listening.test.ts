/**
 * The endpoint harness behind the PostgreSQL suites: the package gate's
 * PgBouncer (`SMITHERS_TEST_PGBOUNCER_URL`) is the one they test, and a named
 * endpoint that does not answer fails the suite instead of skipping it.
 */
import { describe, expect, it } from "@effect/vitest"
import { createServer, type Server } from "node:net"
import { absence, composePgbouncerUrl, pgbouncer, postgres } from "./harness/listening.ts"

const listen = (): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy())
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
const portOf = (server: Server) => (server.address() as { readonly port: number }).port
const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
/** A loopback port nothing listens on. */
const closedPort = async () => {
  const server = await listen()
  const port = portOf(server)
  await close(server)
  return port
}

describe("pgbouncer", () => {
  it("is SMITHERS_TEST_PGBOUNCER_URL, required, when the environment names one", () => {
    const url = "postgres://postgres:secret@127.0.0.1:55440/smithers_adapter_test"
    expect(pgbouncer({ SMITHERS_TEST_PGBOUNCER_URL: url })).toMatchObject({ url, required: true })
  })

  it("falls back to the compose PgBouncer, optional, when the environment names none", () => {
    expect(pgbouncer({})).toMatchObject({ url: composePgbouncerUrl, required: false })
  })
})

describe("absence", () => {
  it("rejects when a named PgBouncer does not answer", async () => {
    const url = `postgres://postgres:secret@127.0.0.1:${await closedPort()}/smithers_adapter_test`
    await expect(absence(pgbouncer({ SMITHERS_TEST_PGBOUNCER_URL: url }))).rejects.toThrow(
      `PgBouncer with pool_mode=transaction: nothing listens on 127.0.0.1:`
    )
  })

  it("skips an optional endpoint that does not answer, and says how to start it", async () => {
    const port = await closedPort()
    const endpoint = { ...pgbouncer({}), url: `postgres://smithers@127.0.0.1:${port}/smithers` }
    expect(await absence(endpoint)).toBe(
      `nothing listens on 127.0.0.1:${port}; run \`docker compose up -d pgbouncer\` in apps/mvp`
    )
  })

  it("skips PostgreSQL when SMITHERS_TEST_PG_URL is unset", async () => {
    expect(await absence(postgres({}))).toBe("SMITHERS_TEST_PG_URL is unset; `pnpm coverage` provides a server")
  })

  it("is undefined when the endpoint answers", async () => {
    const server = await listen()
    try {
      const url = `postgres://postgres@127.0.0.1:${portOf(server)}/postgres`
      expect(await absence(postgres({ SMITHERS_TEST_PG_URL: url }))).toBeUndefined()
      expect(await absence(pgbouncer({ SMITHERS_TEST_PGBOUNCER_URL: url }))).toBeUndefined()
    } finally {
      await close(server)
    }
  })
})
