import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const bounded = (promise, milliseconds, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), milliseconds)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})
const docker = args => {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8", timeout: 15_000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const held = 'console.log("APP_STACK_CANCEL_READY " + process.env.MVP_TEST_STACK_PROJECT); setTimeout(() => {}, 60000)'
const child = spawn("bash", ["db/test-stack.sh", "--", process.execPath, "-e", held], {
  cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
})
let project
let electric
let closed = false
let passed = false
let output = ""
let ready
const readiness = new Promise(resolve => { ready = resolve })
const capture = chunk => {
  const text = chunk.toString()
  process.stdout.write(text)
  output += text
  project ??= /mvp-test-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/.exec(output)?.[0]
  if (/APP_STACK_CANCEL_READY mvp-test-[a-f0-9-]+\n/.test(output)) ready()
}
child.stdout.on("data", capture)
child.stderr.on("data", capture)
const completion = new Promise((resolve, reject) => {
  child.once("error", reject)
  child.once("close", (code, signal) => { closed = true; resolve({ code, signal }) })
})
const compose = args => ["compose", "-p", project, "-f", "docker-compose.yml", "-f", "docker-compose.test.yml", ...args]
try {
  await bounded(Promise.race([
    readiness,
    completion.then(exit => { throw new Error(`Fixture exited before readiness: ${JSON.stringify(exit)}`) }),
  ]), 30_000, "Fixture did not report readiness")
  assert.ok(project)
  electric = docker(compose(["ps", "-q", "electric"]))
  assert.ok(electric)
  // A real, unresponsive dependency must not outlive the runner's termination window.
  docker(["kill", "--signal=STOP", electric])
  const started = performance.now()
  process.kill(-child.pid, "SIGTERM")
  const exit = await bounded(completion, 5_000, "SIGTERM fixture cleanup exceeded five seconds")
  assert.deepEqual(exit, { code: 143, signal: null })
  const filter = `label=com.docker.compose.project=${project}`
  assert.equal(docker(["ps", "-aq", "--filter", filter]), "")
  assert.equal(docker(["volume", "ls", "-q", "--filter", filter]), "")
  assert.equal(docker(["network", "ls", "-q", "--filter", filter]), "")
  passed = true
  console.log(`SIGTERM fixture cleanup passed in ${Math.round(performance.now() - started)} ms`)
} finally {
  if (!closed && child.pid !== undefined) {
    try { process.kill(-child.pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
    await bounded(completion, 5_000, "Fixture process group did not exit")
  }
  if (!passed && project !== undefined) {
    if (electric !== undefined) spawnSync("docker", ["kill", electric], { cwd, timeout: 5_000, stdio: "ignore" })
    docker(compose(["down", "--timeout", "1", "--volumes", "--remove-orphans"]))
  }
}
