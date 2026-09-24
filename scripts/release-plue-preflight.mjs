import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

/** Check the product target before building the release's native and Linux matrices.
 * This receipt establishes reachability and authentication only, never parity.
 */
export const inspectPlueTarget = async (environment, fetcher = fetch) => {
  const report = {
    schemaVersion: 1,
    kind: "release-plue-preflight",
    observedAt: new Date().toISOString(),
    status: "failed",
    checks: [],
    reasons: []
  }
  // Record the requested candidate separately from the observed remote UI.
  // Neither value proves the Plue backend's artifact identity.
  if (environment.SMITHERS_RELEASE_SOURCE_REF) report.requestedSourceRef = environment.SMITHERS_RELEASE_SOURCE_REF
  if (environment.SMITHERS_RELEASE_WORKFLOW_SHA) report.workflowSha = environment.SMITHERS_RELEASE_WORKFLOW_SHA
  const target = environment.SMITHERS_MODE_MATRIX_PLUE_URL?.trim()
  const token = environment.SMITHERS_MODE_MATRIX_PLUE_TOKEN?.trim()
  if (!target) report.reasons.push("SMITHERS_MODE_MATRIX_PLUE_URL is required")
  if (!token) report.reasons.push("SMITHERS_MODE_MATRIX_PLUE_TOKEN is required")
  let origin
  try {
    const url = new URL(target)
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error()
    origin = url.origin
  } catch {
    if (target) report.reasons.push("SMITHERS_MODE_MATRIX_PLUE_URL must be a credential-free HTTP(S) origin")
  }
  if (report.reasons.length) return report
  report.origin = origin

  const probe = async (path, headers, validate) => {
    const check = { path, status: "failed" }
    report.checks.push(check)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      // A redirect must not move a credential to a different target or turn a
      // login page into a successful product response.
      const response = await fetcher(new URL(path, origin), { headers, redirect: "manual", signal: controller.signal })
      check.httpStatus = response.status
      if (!response.ok) {
        await response.body?.cancel()
        report.reasons.push(`${path} returned HTTP ${response.status}`)
        return
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error()
      const chunks = []
      let size = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > 65_536) {
          await reader.cancel()
          throw new Error()
        }
        chunks.push(Buffer.from(value))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (!validate(body)) {
        report.reasons.push(`${path} did not return the expected product contract`)
        return
      }
      check.status = "passed"
    } catch {
      // Response bodies, identity fields, and transport errors can contain
      // credentials. Only allowlisted metadata belongs in public evidence.
      report.reasons.push(`${path} request failed or returned invalid JSON (10 second / 64 KiB limit)`)
    } finally {
      clearTimeout(timer)
    }
  }
  await probe("/api/bootstrap", {}, (body) => {
    if (body?.apiVersion !== 1 || body.host !== "cloud" || typeof body.buildSha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(body.buildSha)) return false
    report.observedBuildSha = body.buildSha
    return true
  })
  await probe("/api/user", { authorization: `token ${token}` }, (body) =>
    Number.isSafeInteger(body?.id) && body.id > 0 && typeof body.username === "string" && body.username.length > 0)
  report.status = report.reasons.length ? "failed" : "passed"
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2]
  if (!output) throw new Error("usage: node scripts/release-plue-preflight.mjs <receipt.json>")
  const report = await inspectPlueTarget(process.env)
  mkdirSync(dirname(resolve(output)), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(`Plue target preflight: ${report.status}. This is not a parity or rollout receipt.`)
  for (const reason of report.reasons) console.error(reason)
  if (report.status !== "passed") process.exitCode = 1
}
