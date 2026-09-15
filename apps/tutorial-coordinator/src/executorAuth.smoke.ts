import { strict as assert } from "node:assert"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { EXECUTOR_TOKEN_ENV, EXECUTOR_TOKEN_HEADER, executorTokenAuthorized } from "../../tutorial-executor/src/executorAuth"

/*
 * The executor pod's shared token (tutorial-executor/src/executorAuth.ts):
 * the pure check, then the real container HTTP boundary launched twice —
 * once token-deployed and once with missing configuration — driven over loopback in-process state only.
 *
 * test.mjs bundles tutorial-executor/src/executor.ts and names the artifact
 * in TUTORIAL_EXECUTOR_ARTIFACT (the smoke cannot carry esbuild inside its
 * own bundle).
 */
const artifact = process.env.TUTORIAL_EXECUTOR_ARTIFACT
if (!artifact) throw new Error("TUTORIAL_EXECUTOR_ARTIFACT must name the bundled executor")

// Missing configuration fails closed; configured tokens must match.
assert.equal(executorTokenAuthorized(undefined, undefined), false)
assert.equal(executorTokenAuthorized("anything", undefined), false)
assert.equal(executorTokenAuthorized("anything", ""), false)
assert.equal(executorTokenAuthorized(undefined, "tok"), false)
assert.equal(executorTokenAuthorized(["tok"], "tok"), false)
assert.equal(executorTokenAuthorized("tok", "tok"), true)
assert.equal(executorTokenAuthorized("Tok", "tok"), false)
assert.equal(executorTokenAuthorized("tok2", "tok"), false)
assert.equal(executorTokenAuthorized("tokk", "tok"), false)

/** A free loopback port, with the usual probe-and-release race accepted for a test. */
const freePort = async (): Promise<number> => {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

interface Launched { readonly port: number; readonly stop: () => Promise<void> }

const launchExecutor = async (bundlePath: string, token: string | undefined): Promise<Launched> => {
  const port = await freePort()
  const child = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, PORT: String(port), [EXECUTOR_TOKEN_ENV]: token ?? "" },
    stdio: "inherit"
  })
  let exited = false
  child.once("exit", code => { exited = true; if (code !== 0 && code !== null) console.error(`executor exited early (${code})`) })
  // The health probe is the tokenless door the kubelet uses; readiness proves listen.
  const deadline = Date.now() + 15_000
  for (;;) {
    if (exited) throw new Error("Executor exited before listening")
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      if (health.status === 200) break
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("Executor did not listen in time")
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return {
    port,
    stop: () => new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL") })
  }
}

const execute = (port: number, token: string | undefined, body: string) =>
  fetch(`http://127.0.0.1:${port}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { [EXECUTOR_TOKEN_HEADER]: token }) },
    body
  })

// Token-deployed: no header and a wrong header are refused before the body
// is even read; the right header reaches the action layer (a malformed JSON
// body earns its own 422, never the auth refusal).
const token = "9f0b1c2d3e4f5678"
const secured = await launchExecutor(artifact, token)
try {
  const health = await fetch(`http://127.0.0.1:${secured.port}/health`)
  assert.equal(health.status, 200, "the readiness probe must stay open")
  const missing = await execute(secured.port, undefined, "not-json")
  assert.equal(missing.status, 401)
  assert.match(await missing.text(), /authentication required/i)
  const wrong = await execute(secured.port, "0000000000000000", "not-json")
  assert.equal(wrong.status, 401)
  const right = await execute(secured.port, token, "not-json")
  assert.equal(right.status, 422)
  assert.doesNotMatch(await right.text(), /authentication required/i)
} finally {
  await secured.stop()
}

// A missing deployment token must never expose execution.
const open = await launchExecutor(artifact, undefined)
try {
  const response = await execute(open.port, undefined, "not-json")
  assert.equal(response.status, 401)
} finally {
  await open.stop()
}

console.log("Executor auth passed: the token-deployed container refuses /execute without the session token, and a missing deployment token fails closed")
