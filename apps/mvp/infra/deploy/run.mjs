/** The deploy program boundary: refuse prerequisites before packing or starting Alchemy. */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { parseEnv } from "node:util"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { preflight } from "./preflight.mjs"

const directory = resolve(import.meta.dirname, "../..")
/** Match Alchemy: shell overrides optional .env; an explicit --env-file overrides shell. */
export const environment = (flags, { env = process.env, cwd = directory } = {}) => {
  let file
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === "--env-file") {
      if (!flags[i + 1] || flags[i + 1].startsWith("--")) throw new Error("--env-file needs a file")
      file = flags[++i]
    } else if (flags[i].startsWith("--env-file=")) file = flags[i].slice("--env-file=".length)
  }
  const path = resolve(cwd, file ?? ".env")
  if (file === undefined && !existsSync(path)) return env
  let loaded
  try { loaded = parseEnv(readFileSync(path, "utf8")) }
  catch { throw new Error("Cannot read deployment environment file; no publication started") }
  return file === undefined ? { ...loaded, ...env } : { ...env, ...loaded }
}

export const run = (args, { check = preflight, command = spawnSync } = {}) => {
  const [operation, ...flags] = args
  if (!["plan", "deploy", "preflight"].includes(operation)) throw new Error("Expected plan, deploy or preflight")
  check({ env: environment(flags) })
  console.log("deploy.preflight: passed")
  if (operation === "preflight") return 0
  console.log("deploy.pack: started")
  const packed = command(process.execPath, ["infra/sandbox/pack-cli.mjs"], { cwd: directory, stdio: "inherit" })
  if (packed.status !== 0) return packed.status ?? 1
  console.log(`deploy.${operation}: started`)
  const result = command("pnpm", ["exec", "alchemy", operation, "--stage", "prod", ...flags], {
    cwd: directory, stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=vibelang/register` }
  })
  return result.status ?? 1
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
