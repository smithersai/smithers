import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { inspectPlueTarget } from "./release-plue-preflight.mjs"

const environment = {
  SMITHERS_MODE_MATRIX_PLUE_URL: "https://candidate.example",
  SMITHERS_MODE_MATRIX_PLUE_TOKEN: "private-token",
  SMITHERS_RELEASE_SOURCE_REF: "b".repeat(40),
  SMITHERS_RELEASE_WORKFLOW_SHA: "c".repeat(40)
}
const bootstrap = { apiVersion: 1, host: "cloud", buildSha: "a".repeat(40) }
const user = { id: 1, username: "private-owner", email: "private@example.test" }
const responseFor = (url) => Response.json(url.pathname === "/api/bootstrap" ? bootstrap : user)

test("validates bootstrap and authenticated product API without archiving identity or credentials", async () => {
  const calls = []
  const report = await inspectPlueTarget(environment, async (url, options) => {
    calls.push({ path: url.pathname, options })
    return responseFor(url)
  })
  assert.equal(report.status, "passed")
  assert.equal(report.observedBuildSha, bootstrap.buildSha)
  assert.equal(report.requestedSourceRef, environment.SMITHERS_RELEASE_SOURCE_REF)
  assert.equal(report.workflowSha, environment.SMITHERS_RELEASE_WORKFLOW_SHA)
  assert.deepEqual(calls.map(({ path }) => path), ["/api/bootstrap", "/api/user"])
  assert.deepEqual(calls[0].options.headers, {})
  assert.deepEqual(calls[1].options.headers, { authorization: "token private-token" })
  assert.ok(calls.every(({ options }) => options.redirect === "manual" && options.signal instanceof AbortSignal))
  assert.doesNotMatch(JSON.stringify(report), /private/)
})

for (const status of [302, 401, 403, 404, 500]) {
  test(`a reachable bootstrap cannot hide product API HTTP ${status}`, async () => {
    const report = await inspectPlueTarget(environment, async (url) => url.pathname === "/api/bootstrap"
      ? Response.json(bootstrap) : new Response("private-token", { status }))
    assert.equal(report.status, "failed")
    assert.deepEqual(report.reasons, [`/api/user returned HTTP ${status}`])
    assert.doesNotMatch(JSON.stringify(report), /private/)
  })
}

test("missing configuration produces a failed receipt without a request", async () => {
  const report = await inspectPlueTarget({}, () => assert.fail("must not fetch"))
  assert.equal(report.status, "failed")
  assert.equal(report.reasons.length, 2)
  assert.deepEqual(report.checks, [])
})

for (const target of ["https://private-token@example.test", "https://example.test/?token=private-token", "https://example.test/api", "file:///tmp/private-token"]) {
  test(`invalid origin is rejected without retaining its value: ${new URL(target).protocol} ${new URL(target).pathname}`, async () => {
    const report = await inspectPlueTarget({ ...environment, SMITHERS_MODE_MATRIX_PLUE_URL: target }, () => assert.fail("must not fetch"))
    assert.equal(report.status, "failed")
    assert.doesNotMatch(JSON.stringify(report), /private-token/)
  })
}

test("bootstrap must identify the cloud product with an exact build", async () => {
  for (const body of [null, {}, { ...bootstrap, host: "local" }, { ...bootstrap, buildSha: "dev" }, { ...bootstrap, buildSha: "a".repeat(41) }, { ...bootstrap, buildSha: [bootstrap.buildSha] }]) {
    const report = await inspectPlueTarget(environment, async (url) => Response.json(url.pathname === "/api/bootstrap" ? body : user))
    assert.equal(report.status, "failed")
    assert.match(report.reasons[0], /bootstrap.*contract/)
  }
})

test("HTML, success-shaped stubs, oversized bodies, and transport errors fail without disclosing their contents", async () => {
  for (const reply of [
    () => new Response("<html>private-token</html>"),
    () => Response.json({ ok: true }),
    () => Response.json({ ...user, data: "private-token".repeat(10_000) }),
    () => { throw new Error("private-token") }
  ]) {
    const report = await inspectPlueTarget(environment, async (url) => url.pathname === "/api/bootstrap" ? Response.json(bootstrap) : reply())
    assert.equal(report.status, "failed")
    assert.doesNotMatch(JSON.stringify(report), /private-token/)
  }
})

test("the CLI persists failure evidence and exits nonzero", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-plue-preflight-"))
  try {
    const output = join(root, "evidence", "receipt.json")
    assert.throws(() => execFileSync(process.execPath, [new URL("./release-plue-preflight.mjs", import.meta.url).pathname, output], {
      env: { ...process.env, SMITHERS_MODE_MATRIX_PLUE_URL: "", SMITHERS_MODE_MATRIX_PLUE_TOKEN: "" }, stdio: "pipe"
    }), { status: 1 })
    assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "failed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
