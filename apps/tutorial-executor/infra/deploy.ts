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
const coordinatorOnly = process.argv.includes("--coordinator-only")
const reuseImage = process.argv.includes("--reuse-image")
if (reuseImage && !coordinatorOnly) throw new Error("Image reuse requires a coordinator-only release")
const currentDeployment = coordinatorOnly ? JSON.parse(run("kubectl", ["get", "deployment", "tutorial-coordinator", "-n", "smithers", "-o", "json"], { quiet: true })) : undefined
const executorImage = coordinatorOnly
  ? currentDeployment.spec.template.spec.containers.find((container: any) => container.name === "coordinator").env.find((value: any) => value.name === "TUTORIAL_EXECUTOR_IMAGE")?.value
  : `${registry}/smithers-tutorial-executor:${release}`
if (!executorImage) throw new Error("Existing executor image is missing")
const coordinatorImage = `${registry}/smithers-tutorial-coordinator:${release}`
const directory = mkdtempSync(join(tmpdir(), "smithers-tutorial-release-"))
try {
  if (reuseImage) {
    // Resume after a post-push failure only when the exact release exists.
    run("gcloud", ["artifacts", "docker", "images", "describe", coordinatorImage, "--format=value(image_summary.digest)"], { quiet: true })
  } else {
    run("gcloud", ["auth", "configure-docker", "us-central1-docker.pkg.dev", "--quiet"])
    if (!coordinatorOnly) run("docker", ["buildx", "build", "--platform", "linux/amd64", "-f", "apps/tutorial-executor/Dockerfile", "-t", executorImage, "--push", "."])
    copyFileSync("dist/tutorial-coordinator/server.mjs", join(directory, "server.mjs"))
    copyFileSync("apps/tutorial-executor/infra/coordinator.Dockerfile", join(directory, "Dockerfile"))
    run("docker", ["buildx", "build", "--platform", "linux/amd64", "-t", coordinatorImage, "--push", directory])
  }
  // Never print credential-bearing objects. Keep the service token stable across
  // releases, so a rolling Worker release never loses its authenticated link.
  let old: any = undefined
  try { old = JSON.parse(run("kubectl", ["get", "secret", "tutorial-coordinator-secrets", "-n", "smithers", "-o", "json"], { quiet: true })) } catch {}
  // A runtime fix must preserve the live provider unless an operator selects
  // another one. Otherwise a coordinator-only release silently changes auth.
  const previousProvider = old?.data?.TUTORIAL_PROVIDER === undefined ? undefined : Buffer.from(old.data.TUTORIAL_PROVIDER, "base64").toString()
  const provider = process.env.TUTORIAL_PROVIDER ?? (coordinatorOnly ? previousProvider : undefined) ?? "chatgpt"
  const previousModel = provider === previousProvider && old?.data?.TUTORIAL_MODEL !== undefined ? Buffer.from(old.data.TUTORIAL_MODEL, "base64").toString() : undefined
  const model = process.env.TUTORIAL_MODEL ?? (coordinatorOnly ? previousModel : undefined) ?? (provider === "chatgpt" ? "gpt-5.6-luna" : undefined)
  if (!["chatgpt", "gemini", "openai"].includes(provider) || !model) throw new Error("Configure tutorial provider and model")
  const credentialData: Record<string, string> = {}
  if (provider === "chatgpt") {
    const file = process.env.TUTORIAL_CHATGPT_AUTH_FILE
    if (file) {
      const contents = readFileSync(file, "utf8")
      const auth = JSON.parse(contents)
      if (!auth.tokens?.access_token || !auth.tokens?.refresh_token) throw new Error("The tutorial login must use ChatGPT subscription authentication")
      const bootstrap = { apiVersion: "v1", kind: "Secret", metadata: { name: "tutorial-chatgpt-bootstrap", namespace: "smithers" }, type: "Opaque", data: { "auth.json": Buffer.from(contents).toString("base64") } }
      run("kubectl", ["apply", "-f", "-"], { input: JSON.stringify(bootstrap), quiet: true })
    } else {
      run("kubectl", ["get", "secret", "tutorial-chatgpt-bootstrap", "-n", "smithers", "-o", "name"], { quiet: true })
    }
  } else {
    const variable = provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"
    const existing = old?.data?.[variable] === undefined ? undefined : Buffer.from(old.data[variable], "base64").toString()
    const key = process.env[variable] ?? existing
    if (!key || key.length < 10 || /placeholder|changeme|dummy|bootstrap[-_]seed/i.test(key)) throw new Error("Configure a genuine provider credential")
    credentialData[variable] = Buffer.from(key).toString("base64")
  }
  const token = old?.data?.TUTORIAL_SERVICE_TOKEN ?? randomBytes(32).toString("hex")
  const encodedToken = old?.data?.TUTORIAL_SERVICE_TOKEN === undefined ? Buffer.from(token).toString("base64") : token
  const secret = { apiVersion: "v1", kind: "Secret", metadata: { name: "tutorial-coordinator-secrets", namespace: "smithers" }, type: "Opaque",
    data: { TUTORIAL_SERVICE_TOKEN: encodedToken, ...credentialData, TUTORIAL_PROVIDER: Buffer.from(provider).toString("base64"), TUTORIAL_MODEL: Buffer.from(model).toString("base64") } }
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
