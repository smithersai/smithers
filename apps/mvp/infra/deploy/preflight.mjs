/** Read-only prerequisites. Probe output and environment values never enter diagnostics. */
import { spawnSync } from "node:child_process"
import { assertInstalled, deploymentGraph } from "./filter.mjs"

export const tool = (name, args) => {
  const result = spawnSync(name, args, { stdio: "ignore", timeout: 30_000 })
  return result.status === 0
}

export const preflight = ({ env = process.env, probe = tool, dependencies = () => {
  const { packages, directories } = deploymentGraph()
  assertInstalled(packages, directories)
}, nodeVersion = process.versions.node } = {}) => {
  const failures = []
  const [major, minor] = nodeVersion.split(".").map(Number)
  if (major < 26 || (major === 26 && minor < 4)) failures.push("Node 26.4 or later is required")
  for (const command of ["pnpm", "npm"]) {
    if (!probe(command, ["--version"])) failures.push(`${command} is missing or cannot start`)
  }
  if (!probe("docker", ["--version"])) failures.push("docker is missing or cannot start")
  else {
    if (!probe("docker", ["info", "--format", "{{.ServerVersion}}"])) {
      failures.push("container engine is stopped or unreachable; start your container engine and retry")
    }
    if (!probe("docker", ["buildx", "version"])) failures.push("Docker Buildx is missing")
    else if (!probe("docker", ["buildx", "inspect", "--bootstrap"])) failures.push("Docker Buildx builder is unavailable")
  }
  const required = new Set(["APP_DOMAIN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "ALCHEMY_PASSWORD", "NEON_API_KEY"])
  // Model configuration names credentials; the credential's value stays in the environment.
  if (!env.CHAT_MODEL) required.add("CEREBRAS_API_KEY")
  const credentials = (record) => {
    if (!record || typeof record !== "object") return
    for (const [key, value] of Object.entries(record)) {
      if (key === "credential" && typeof value === "string") required.add(value)
      else if (value && typeof value === "object") credentials(value)
    }
  }
  for (const name of ["CHAT_MODEL", "SUMMARY_MODEL", "TIER_MODELS"]) {
    if (!env[name]) continue
    try { credentials(JSON.parse(env[name])) }
    catch { failures.push(`${name} is invalid JSON`) }
  }
  for (const name of required) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) failures.push("model credential must name an environment variable")
    else if (!env[name]?.trim()) failures.push(`${name} is unresolved`)
  }
  for (const [first, second] of [
    ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"],
    ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"],
    ["CODE_STORAGE_ORG", "CODE_STORAGE_KEY"]
  ]) {
    if (Boolean(env[first]?.trim()) !== Boolean(env[second]?.trim())) failures.push(`${first} and ${second} must resolve together`)
  }
  try { dependencies() } catch (error) { failures.push(error.message) }
  if (failures.length) throw new Error("Deploy preflight failed before publication:\n- " + failures.join("\n- "))
  return { status: "passed", checks: ["tools", "container-engine", "builder", "credentials", "dependencies"] }
}
