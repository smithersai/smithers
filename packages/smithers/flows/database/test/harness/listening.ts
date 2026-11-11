/**
 * Whether a PostgreSQL endpoint is there to test against.
 *
 * @since 1.0.0
 */
import { connect } from "node:net"

/**
 * Resolves whether anything accepts TCP connections at `url`'s host and port.
 * Only a refused connection means the service is absent; any other error
 * rejects, so a misconfigured endpoint fails the suite instead of skipping it.
 *
 * @since 1.0.0
 * @category predicates
 */
export const listening = (url: string): Promise<boolean> => {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port || 5432) })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once(
      "error",
      (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve(false) : reject(error)
    )
  })
}

/**
 * The compose PgBouncer (`apps/mvp/docker-compose.yml`): transaction pooling
 * over the compose PostgreSQL, with every server connection reset when its
 * transaction ends, as Cloudflare Hyperdrive does.
 *
 * @since 1.0.0
 * @category constants
 */
export const composePgbouncerUrl = "postgres://smithers:smithers@127.0.0.1:54322/smithers"

/**
 * A server a suite runs its cases against. `required` endpoints were named
 * by the environment, so nothing listening there is a failure, not a skip.
 *
 * @since 1.0.0
 * @category models
 */
export interface Endpoint {
  readonly name: string
  readonly url: string | undefined
  readonly required: boolean
  /** How to provide the server where it is absent. */
  readonly start: string
}

/**
 * The direct PostgreSQL server: `SMITHERS_TEST_PG_URL`, which the storage
 * matrix sets for its PostgreSQL lane.
 *
 * @since 1.0.0
 * @category constructors
 */
export const postgres = (env: NodeJS.ProcessEnv = process.env): Endpoint => ({
  name: "PostgreSQL",
  url: env.SMITHERS_TEST_PG_URL,
  required: false,
  start: "`pnpm coverage` provides a server"
})

/**
 * PgBouncer with `pool_mode=transaction`: `SMITHERS_TEST_PGBOUNCER_URL` (the
 * package gate's declared pooler, or a farm slot's) when set, which must
 * answer, and otherwise the compose PgBouncer where it runs.
 *
 * @since 1.0.0
 * @category constructors
 */
export const pgbouncer = (env: NodeJS.ProcessEnv = process.env): Endpoint => ({
  name: "PgBouncer with pool_mode=transaction",
  url: env.SMITHERS_TEST_PGBOUNCER_URL ?? composePgbouncerUrl,
  required: env.SMITHERS_TEST_PGBOUNCER_URL !== undefined,
  start: "run `docker compose up -d pgbouncer` in apps/mvp"
})

/**
 * Why `endpoint`'s cases skip, or `undefined` when something listens there.
 * Rejects when a required endpoint does not answer.
 *
 * @since 1.0.0
 * @category predicates
 */
export const absence = async (endpoint: Endpoint): Promise<string | undefined> => {
  if (endpoint.url === undefined) return `SMITHERS_TEST_PG_URL is unset; ${endpoint.start}`
  if (await listening(endpoint.url)) return undefined
  const host = new URL(endpoint.url).host
  if (endpoint.required) throw new Error(`${endpoint.name}: nothing listens on ${host}, which the environment names`)
  return `nothing listens on ${host}; ${endpoint.start}`
}
