/** Dedicated tutorial release, never changes the Worker identity or existing service workloads.
 * Run with bun from the repository root after bundle+executor tests pass.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
const expected = "gke_plue-prod-1771780303_us-central1_plue-cluster"
const run = (cmd: string, args: string[], options: { input?: string; quiet?: boolean } = {}) => execFileSync(cmd, args, { encoding: "utf8", input: options.input, stdio: options.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "inherit"] })
if (run("kubectl", ["config", "current-context"], { quiet: true }).trim() !== expected) throw new Error("Refusing unexpected Kubernetes context")
const release = process.argv[2]
if (!release || !/^[a-z0-9][a-z0-9.-]{1,60}$/.test(release)) throw new Error("Provide a unique lowercase release tag")
const registry = "us-central1-docker.pkg.dev/plue-prod-1771780303/smithers"
const executorImage = `${registry}/smithers-tutorial-executor:${release}`
const coordinatorImage = `${registry}/smithers-tutorial-coordinator:${release}`
const directory = mkdtempSync(join(tmpdir(), "smithers-tutorial-release-"))
try {
  run("gcloud", ["auth", "configure-docker", "us-central1-docker.pkg.dev", "--quiet"])
  run("docker", ["buildx", "build", "--platform", "linux/amd64", "-f", "apps/tutorial-executor/Dockerfile", "-t", executorImage, "--push", "."])
  copyFileSync("dist/tutorial-coordinator/server.mjs", join(directory, "server.mjs"))
  copyFileSync("apps/tutorial-executor/infra/coordinator.Dockerfile", join(directory, "Dockerfile"))
  run("docker", ["buildx", "build", "--platform", "linux/amd64", "-t", coordinatorImage, "--push", directory])
  // Never print credential-bearing objects. Keep the service token stable across
  // releases, so a rolling Worker release never loses its authenticated link.
  const source = JSON.parse(run("kubectl", ["get", "secret", "smithers-secrets", "-n", "smithers", "-o", "json"], { quiet: true }))
  let old: any = undefined
  try { old = JSON.parse(run("kubectl", ["get", "secret", "tutorial-coordinator-secrets", "-n", "smithers", "-o", "json"], { quiet: true })) } catch {}
  const usable = (value: string | undefined) => value !== undefined && value.length > 10 && !/placeholder|changeme|dummy|bootstrap[-_]seed/i.test(value)
  const existingKey = old?.data?.GEMINI_API_KEY === undefined ? undefined : Buffer.from(old.data.GEMINI_API_KEY, "base64").toString()
  const sharedKey = source.data?.GEMINI_API_KEY === undefined ? undefined : Buffer.from(source.data.GEMINI_API_KEY, "base64").toString()
  const providerKey = [process.env.GEMINI_API_KEY, existingKey, sharedKey].find(usable)
  if (providerKey === undefined) throw new Error("No genuine configured Gemini provider credential; refusing placeholder credentials")
  const token = old?.data?.TUTORIAL_SERVICE_TOKEN ?? randomBytes(32).toString("hex")
  const encodedToken = old?.data?.TUTORIAL_SERVICE_TOKEN === undefined ? Buffer.from(token).toString("base64") : token
  const secret = { apiVersion: "v1", kind: "Secret", metadata: { name: "tutorial-coordinator-secrets", namespace: "smithers" }, type: "Opaque",
    data: { TUTORIAL_SERVICE_TOKEN: encodedToken, GEMINI_API_KEY: Buffer.from(providerKey).toString("base64"), TUTORIAL_PROVIDER: Buffer.from("gemini").toString("base64"), TUTORIAL_MODEL: Buffer.from("gemini-3-flash-preview").toString("base64") } }
  run("kubectl", ["apply", "-f", "-"], { input: JSON.stringify(secret), quiet: true })
  const manifest = readFileSync("apps/tutorial-executor/infra/runtime.yaml", "utf8").replaceAll("__COORDINATOR_IMAGE__", coordinatorImage).replaceAll("__EXECUTOR_IMAGE__", executorImage)
  const manifestPath = join(directory, "runtime.yaml"); writeFileSync(manifestPath, manifest)
  run("kubectl", ["apply", "-f", manifestPath])
  run("kubectl", ["rollout", "status", "deployment/tutorial-coordinator", "-n", "smithers", "--timeout=180s"])
  if (!process.argv.includes("--no-ingress")) {
  const ingress = JSON.parse(run("kubectl", ["get", "ingress", "smithers-ingress", "-n", "smithers", "-o", "json"], { quiet: true }))
  const rule = ingress.spec.rules.findIndex((rule: any) => rule.host === "api.jjhub.tech")
  if (rule < 0) throw new Error("Existing ingress host missing")
  const existing = ingress.spec.rules[rule].http.paths.find((path: any) => path.path === "/__tutorial")
  if (existing === undefined) run("kubectl", ["patch", "ingress", "smithers-ingress", "-n", "smithers", "--type=json", "-p", JSON.stringify([
    { op: "test", path: "/metadata/resourceVersion", value: ingress.metadata.resourceVersion },
    { op: "add", path: `/spec/rules/${rule}/http/paths/0`, value: { path: "/__tutorial", pathType: "Prefix", backend: { service: { name: "tutorial-coordinator", port: { number: 3000 } } } } }
  ])])
  }
  // Deliberately no token output: the Worker deployer reads the same K8s key
  // directly into wrangler secret stdin. This release never edits CF bindings.
  console.log(`Tutorial release ${release}; authenticated endpoint https://api.jjhub.tech/__tutorial`)
} finally { rmSync(directory, { recursive: true, force: true }) }
