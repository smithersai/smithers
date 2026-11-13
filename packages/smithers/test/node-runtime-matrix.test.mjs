import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

for (const kind of ["tarball", "directory"]) test("the " + kind + " matrix runs the exact candidate and records each runner's installed identity", { timeout: 180_000, skip: process.platform !== "linux" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "matrix-candidate-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pkg = join(root, "package")
  mkdirSync(pkg)
  const version = "0.0.0-matrix-candidate"
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@smthrs/cli", version, type: "module", bin: { "candidate-cli": "./entry.mjs" },
  }))
  writeFileSync(join(pkg, "entry.mjs"), [
    "#!/usr/bin/env node",
    'import { mkdirSync, writeFileSync } from "node:fs"',
    'if (Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) < 19) {',
    'console.error("smthrs needs Node 22.19.0 or later"); process.exit(1)',
    '}',
    'if (process.argv[2] === "init") writeFileSync("WORKSPACE.ts", "node >=22.19.0")',
    'if (process.argv[2] === "generate") {',
    'mkdirSync(".smithers/flows/coding", { recursive: true })',
    'writeFileSync(".smithers/flows/coding/flow.ts", "candidate")',
    '}',
    'console.log("' + version + '")',
  ].join("\n") + "\n")
  chmodSync(join(pkg, "entry.mjs"), 0o755)
  const tarball = join(root, "candidate.tgz")
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"])
  writeFileSync(join(root, "manifest.json"), JSON.stringify([{ name: "@smthrs/cli", version, filename: "candidate.tgz" }]))
  const candidate = kind === "tarball" ? tarball : root
  // No published package can satisfy this test. These are real npm/bunx
  // invocations with a clean cache and a registry that refuses all packages.
  const requests = []
  const registry = createServer((request, response) => {
    requests.push(request.url)
    response.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}')
  })
  await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve))
  t.after(() => { registry.closeAllConnections(); registry.close() })
  const output = join(root, "results")
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("./node-runtime-matrix.mjs", import.meta.url).pathname, candidate], {
      env: {
        ...process.env,
        MATRIX_OUTPUT: output, MATRIX_VERSIONS: "22.4.1,26.4.0",
        npm_config_audit: "false", npm_config_update_notifier: "false",
        npm_config_registry: "http://127.0.0.1:" + registry.address().port,
        npm_config_fetch_retries: "0",
      },
      stdio: ["ignore", "pipe", "pipe"], timeout: 150_000,
    })
    let log = ""
    child.stdout.on("data", chunk => { log += chunk })
    child.stderr.on("data", chunk => { log += chunk })
    child.on("error", reject)
    child.on("close", status => resolve({ status, log }))
  })
  assert.equal(result.status, 0, result.log)
  const receipt = JSON.parse(readFileSync(join(output, "results.json"), "utf8"))
  const runners = receipt.results.filter(row => /^(npx|bunx) /.test(row.command))
  assert.equal(runners.length, 4)
  for (const row of runners) {
    assert.equal(row.passed, true, JSON.stringify(row))
    assert.ok(row.command.includes(kind === "tarball" ? candidate : "@smthrs/cli@next"), row.command)
    assert.equal(row.identity.name, "@smthrs/cli")
    assert.equal(row.identity.version, version)
    assert.equal(row.identity.executable, "candidate-cli")
    assert.equal(row.identity.bin, "entry.mjs")
    assert.equal(row.identity.sha256, createHash("sha256").update(readFileSync(join(pkg, "entry.mjs"))).digest("hex"))
  }
  assert.deepEqual(requests, [], "runner unexpectedly contacted the public-package registry")
})
