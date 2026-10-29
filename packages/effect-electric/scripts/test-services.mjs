/** Run the coverage suite with real Postgres and Electric, including on a clean CI runner. */
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

const composeFile = fileURLToPath(new URL("./test-services.yaml", import.meta.url))
const project = `smithers-electric-${randomUUID()}`
const composeArgs = ["compose", "--file", composeFile, "--project-name", project]
let child
let owned = false
let interrupted
let failure
const interrupt = (signal) => {
  interrupted = signal
  child?.kill(signal)
}
const onInterrupt = () => interrupt("SIGINT")
const onTerminate = () => interrupt("SIGTERM")
process.on("SIGINT", onInterrupt)
process.on("SIGTERM", onTerminate)

const run = (command, args, environment = process.env) => new Promise((resolve, reject) => {
  if (interrupted) return reject(new Error("Test runner interrupted"))
  const current = spawn(command, args, { env: environment, stdio: "inherit" })
  child = current
  current.once("error", reject)
  current.once("exit", (code, signal) => {
    if (child === current) child = undefined
    if (code === 0) resolve()
    else reject(new Error(`${command} exited ${signal ?? code}`))
  })
})

const port = (service, containerPort) => {
  const result = spawnSync("docker", [...composeArgs, "port", service, String(containerPort)], { encoding: "utf8" })
  if (result.error || result.status !== 0) throw new Error(`Cannot discover ${service}'s test port`)
  const address = result.stdout.trim()
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error(`Invalid ${service} test bind`)
  return address
}

try {
  let environment = { ...process.env, SMITHERS_ELECTRIC_TEST_REQUIRED: "1" }
  if (Boolean(environment.ELECTRIC_URL) !== Boolean(environment.DATABASE_URL)) {
    throw new Error("Provide both ELECTRIC_URL and DATABASE_URL for an existing test stack")
  }
  if (!environment.ELECTRIC_URL && !environment.DATABASE_URL) {
    // Preserve the package's existing local-compose contract, also used by
    // the Latitude namespace. A clean CI runner instead provisions its own.
    const local = await fetch("http://localhost:30001/v1/health", { signal: AbortSignal.timeout(2_000) })
      .then((response) => response.ok, () => false)
    if (local) environment = {
      ...environment,
      ELECTRIC_URL: "http://localhost:30001",
      DATABASE_URL: "postgresql://smithers:smithers@localhost:54321/smithers"
    }
  }
  if (!environment.ELECTRIC_URL || !environment.DATABASE_URL) {
    console.log("Electric test dependencies: starting isolated containers")
    owned = true
    await run("docker", [...composeArgs, "up", "--detach", "--wait", "--wait-timeout", "90"])
    environment = {
      ...environment,
      ELECTRIC_URL: `http://${port("electric", 3000)}`,
      DATABASE_URL: `postgresql://smithers:smithers@${port("postgres", 5432)}/smithers?sslmode=disable`
    }
  } else console.log("Electric test dependencies: using the existing stack")
  await run(process.execPath, [
    fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
    "run", "--config", "vitest.config.ts", "--environment", "node", ...process.argv.slice(2)
  ], environment)
} catch (error) {
  failure = error
  throw error
} finally {
  process.off("SIGINT", onInterrupt)
  process.off("SIGTERM", onTerminate)
  if (owned) {
    const stopped = spawnSync("docker", [...composeArgs, "down", "--volumes", "--timeout", "10"], {
      stdio: "inherit", timeout: 30_000
    })
    if (stopped.error || stopped.status !== 0) {
      const cleanup = new Error("Electric test stack cleanup failed")
      throw failure ? new AggregateError([failure, cleanup], "Electric test execution and cleanup failed") : cleanup
    }
  }
  if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143
}
