/**
 * The cache as `docs/concepts/cache.md` says to host it: a Postgres database
 * holding the cache's tables, and the cache service from
 * `packages/smithers/build`. Both are real processes on this machine.
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import { type AddressInfo, createServer } from "node:net"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { remove, temporary } from "../cli/repo.ts"

const cacheModule = fileURLToPath(new URL("../../../smithers/build/terraform/modules/cache/", import.meta.url))

/** The file that creates the cache's tables. */
export const tables = join(cacheModule, "migrations", "0001_initial.sql")

/** The cache service's entry file, which Bun runs. */
export const service = join(cacheModule, "service", "server.js")

const searchPath = (process.env["PATH"] ?? "").split(delimiter).filter((directory) => directory !== "")

const holds = (directory: string, programs: ReadonlyArray<string>): boolean =>
  programs.every((program) => existsSync(join(directory, program)))

const versionsUnder = (root: string): ReadonlyArray<string> =>
  existsSync(root) ? readdirSync(root).sort().reverse().map((version) => join(root, version, "bin")) : []

/** Where Postgres's programs are: on `PATH`, or where Debian, Ubuntu and Homebrew install them. */
const postgres = [
  ...searchPath,
  ...versionsUnder("/usr/lib/postgresql"),
  ...versionsUnder("/opt/homebrew/opt"),
  ...versionsUnder("/usr/local/opt")
].find((directory) => holds(directory, ["initdb", "postgres", "pg_isready", "createdb", "psql"]))

const bun = searchPath.find((directory) => holds(directory, ["bun"]))

/** True when this machine has what the hosting page asks for: Bun and Postgres. */
export const hostable = postgres !== undefined && bun !== undefined

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })

const ended = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once("exit", () => resolve())
  })

/** Asks until `ready` or the process has ended; rejects after two minutes. */
const awaitReady = async (what: string, child: ChildProcess, ready: () => Promise<boolean>): Promise<void> => {
  const end = Date.now() + 120_000
  while (!(await ready())) {
    if (child.exitCode !== null) throw new Error(`${what} ended with code ${child.exitCode}`)
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** A running cache. Its tokens are made for this run and are never printed. */
export interface Hosted {
  readonly url: string
  /** The token that may only read results. */
  readonly readToken: string
  /** The token that may also store results. */
  readonly writeToken: string
  /** How many results the cache holds. */
  readonly stored: () => number
  /** What the service printed. */
  readonly log: () => string
  readonly stop: () => Promise<void>
}

const token = (): string => randomBytes(32).toString("hex")

/** Starts a database and the cache service on loopback ports, with a new pair of tokens. */
export const host = async (): Promise<Hosted> => {
  const bin = (program: string): string => join(postgres as string, program)
  const directory = temporary("cache-host")
  const databasePort = await freePort()
  const address = ["-h", "127.0.0.1", "-p", String(databasePort), "-U", "postgres"]
  execFileSync(bin("initdb"), ["-D", directory, "-U", "postgres", "-A", "trust", "--no-sync"], { stdio: "ignore" })
  const database = spawn(
    bin("postgres"),
    [
      "-D",
      directory,
      "-p",
      String(databasePort),
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      "unix_socket_directories=",
      "-c",
      "fsync=off"
    ],
    { stdio: "ignore" }
  )
  const stopDatabase = async (): Promise<void> => {
    // SIGINT asks Postgres to close its connections and stop at once.
    database.kill("SIGINT")
    await ended(database)
    remove(directory)
  }
  try {
    await awaitReady(
      "the database",
      database,
      () => Promise.resolve(spawnSync(bin("pg_isready"), address).status === 0)
    )
    // The two commands of the hosting page.
    execFileSync(bin("createdb"), [...address, "smithers_cache"], { stdio: "ignore" })
    execFileSync(bin("psql"), [...address, "-d", "smithers_cache", "-q", "-v", "ON_ERROR_STOP=1", "-f", tables], {
      stdio: "ignore"
    })
  } catch (cause) {
    await stopDatabase()
    throw cause
  }

  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const readToken = token()
  const writeToken = token()
  let printed = ""
  const server = spawn(join(bun as string, "bun"), [service], {
    env: {
      PATH: process.env["PATH"],
      DATABASE_URL: `postgres://postgres@127.0.0.1:${databasePort}/smithers_cache`,
      PORT: String(port),
      SMITHERS_CACHE_READ_TOKEN: readToken,
      SMITHERS_CACHE_WRITE_TOKEN: writeToken
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  server.stdout.setEncoding("utf8").on("data", (chunk: string) => void (printed += chunk))
  server.stderr.setEncoding("utf8").on("data", (chunk: string) => void (printed += chunk))
  const stop = async (): Promise<void> => {
    server.kill("SIGTERM")
    await ended(server)
    await stopDatabase()
  }
  try {
    await awaitReady(
      "the cache service",
      server,
      () => fetch(`${url}/healthz`).then((response) => response.ok, () => false)
    )
  } catch (cause) {
    await stop()
    throw new Error(`${String(cause)}\n${printed}`)
  }
  return {
    url,
    readToken,
    writeToken,
    stored: () =>
      Number(
        execFileSync(
          bin("psql"),
          [...address, "-d", "smithers_cache", "-At", "-c", "select count(*) from smithers_build_cache_entry"],
          { encoding: "utf8" }
        )
      ),
    log: () => printed,
    stop
  }
}
