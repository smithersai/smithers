// Lane database readiness: credentials stay in the child's environment; diagnostics contain only the host.
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { diagnostic, libpqEnvironment, parse } from "./Policy.ts"

export const probe = (connection: string, env: NodeJS.ProcessEnv): { code: number; message?: string } => {
  try {
    const clean = libpqEnvironment(connection, env)
    const options = { env: clean, stdio: "ignore" as const, timeout: 10_000 }
    if (spawnSync("psql", ["-X", "-Atc", "select 1"], options).status === 0 ||
      spawnSync("pg_isready", [], options).status === 0) return { code: 0 }
    return { code: 1, message: `BLOCKED: no PostgreSQL at ${parse(connection).hostname} (database tests must run, not skip)` }
  } catch (error) {
    return { code: 1, message: `BLOCKED: ${diagnostic(error, connection)}` }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = probe(process.env.SMITHERS_TEST_DATABASE_URL ?? "", process.env)
  if (result.message) console.log(result.message)
  process.exitCode = result.code
}
