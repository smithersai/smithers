import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { request as httpsRequest } from "node:https"

export interface Snapshot { files: Record<string, string>; base: string; head: string }
export interface TestResult { code: number; stdout: string; stderr: string; command: string }
export interface CommitResult { sha: string; subject: string; parent: string }
export interface DiffResult { base: string; head: string; patch: string }
export interface Executor {
  snapshot(): Promise<Snapshot>
  files(): Promise<Record<string, string>>
  apply(files: Record<string, string>): Promise<Record<string, string>>
  test(): Promise<TestResult>
  commit(message: string, idempotencyKey?: string): Promise<CommitResult>
  diff(base?: string): Promise<DiffResult>
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const namespace = process.env.TUTORIAL_NAMESPACE ?? "smithers-tutorial"
const image = process.env.TUTORIAL_EXECUTOR_IMAGE ?? ""
const pending = new Map<string, Promise<Executor>>()
const podName = (session: string) => `tutorial-${createHash("sha256").update(session).digest("hex").slice(0, 40)}`

async function kubernetes(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const [token, ca] = await Promise.all([
    readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8"),
    readFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
  ])
  return new Promise((done, reject) => {
    const outgoing = httpsRequest({ hostname: process.env.KUBERNETES_SERVICE_HOST, port: Number(process.env.KUBERNETES_SERVICE_PORT ?? 443), path,
      method, ca, headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json" }, timeout: 10_000 }, incoming => {
      const chunks: Buffer[] = []; let size = 0
      incoming.on("data", chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { outgoing.destroy(new Error("Kubernetes reply exceeds limit")); return }; chunks.push(chunk) })
      incoming.on("end", () => { try { done({ status: incoming.statusCode ?? 500, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") }) } catch (error) { reject(error) } })
    })
    outgoing.on("timeout", () => outgoing.destroy(new Error("Kubernetes request timed out")))
    outgoing.on("error", reject)
    outgoing.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const podsPath = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`

async function collectExpired() {
  const result = await kubernetes("GET", `${podsPath}?labelSelector=app%3Dsmithers-tutorial-executor`)
  if (result.status !== 200) throw new Error("Tutorial capacity could not be checked")
  const now = Date.now()
  for (const pod of result.body.items ?? []) {
    const created = Date.parse(pod.metadata?.creationTimestamp ?? "")
    if (now - created > 3_600_000 || ["Failed", "Succeeded"].includes(pod.status?.phase)) {
      await kubernetes("DELETE", `${podsPath}/${encodeURIComponent(pod.metadata.name)}`, { gracePeriodSeconds: 0 })
    }
  }
}

async function provision(session: string): Promise<Executor> {
  if (image === "") throw new Error("Tutorial executor image is not configured")
  if (session.length < 16 || session.length > 256) throw new Error("Invalid tutorial session")
  await collectExpired()
  const name = podName(session)
  const path = `${podsPath}/${name}`
  let result = await kubernetes("GET", path)
  if (result.status === 404) {
    result = await kubernetes("POST", podsPath, {
      apiVersion: "v1", kind: "Pod", metadata: { name, namespace, labels: { app: "smithers-tutorial-executor" } },
      spec: {
        runtimeClassName: "gvisor", automountServiceAccountToken: false, restartPolicy: "Never", activeDeadlineSeconds: 3600,
        terminationGracePeriodSeconds: 1,
        securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
        containers: [{ name: "executor", image, ports: [{ containerPort: 3001 }],
          resources: { requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "256Mi" }, limits: { cpu: "1", memory: "512Mi", "ephemeral-storage": "512Mi" } },
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
          readinessProbe: { httpGet: { path: "/health", port: 3001 }, initialDelaySeconds: 1, periodSeconds: 2 },
          volumeMounts: [{ name: "workspace", mountPath: "/workspace" }, { name: "tmp", mountPath: "/tmp" }]
        }], volumes: [{ name: "workspace", emptyDir: { sizeLimit: "128Mi" } }, { name: "tmp", emptyDir: { sizeLimit: "32Mi" } }]
      }
    })
    if (result.status !== 201 && result.status !== 409) throw new Error(result.status === 403 ? "All tutorial workspaces are busy. Try again shortly." : "Tutorial workspace could not start")
  } else if (result.status !== 200) throw new Error("Tutorial workspace could not be read")
  let ip: string | undefined
  for (let attempt = 0; attempt < 180; attempt++) {
    const pod = await kubernetes("GET", path)
    if (pod.status !== 200) throw new Error("Tutorial workspace disappeared")
    if (["Failed", "Succeeded"].includes(pod.body.status?.phase)) throw new Error("Tutorial workspace expired. Start a new tutorial.")
    if (pod.body.status?.conditions?.some((condition: any) => condition.type === "Ready" && condition.status === "True")) {
      ip = pod.body.status.podIP; break
    }
    await sleep(1000)
  }
  if (ip === undefined || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error("Tutorial workspace is still starting. Try again shortly.")
  const call = async <T>(action: string, values: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetch(`http://${ip}:3001/execute`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...values }), signal: AbortSignal.timeout(45_000) })
    const body = await response.json() as T & { message?: string }
    if (!response.ok) throw new Error(body.message ?? "Tutorial executor failed")
    return body
  }
  return {
    snapshot: () => call<Snapshot>("snapshot"),
    files: async () => (await call<{ files: Record<string, string> }>("files")).files,
    apply: async files => (await call<{ files: Record<string, string> }>("apply", { files })).files,
    test: () => call<TestResult>("test"), commit: (message, idempotencyKey) => call<CommitResult>("commit", { message, idempotencyKey }),
    diff: base => call<DiffResult>("diff", { ...(base === undefined ? {} : { base }) })
  }
}

export function ensure(session: string): Promise<Executor> {
  const existing = pending.get(session)
  if (existing !== undefined) return existing
  const created = provision(session).finally(() => { pending.delete(session) })
  pending.set(session, created)
  return created
}
export const KubernetesExecutor = { ensure }
