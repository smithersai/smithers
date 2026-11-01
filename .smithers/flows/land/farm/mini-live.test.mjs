import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { runProcess } from "../process.mjs"

const host = process.env.DEVX_MINI_TEST_HOST
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const ssh = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlMaster=no", "-o", "ControlPath=none"]
const command = async (text) => {
  const result = await runProcess("ssh", [...ssh, host, text], { timeoutMs: 60000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test("real mini helper completes, propagates failure, cancels its group and removes its temporary files", { skip: !host, timeout: 120000 }, async () => {
  // This tiny zero-dependency protocol fixture is independent of occupied app slots.
  const root = await command("mktemp -d /tmp/smithers-devx-mini-live.XXXXXX")
  assert.match(root, /^\/tmp\/smithers-devx-mini-live\.[a-zA-Z0-9]+$/)
  /** @type {Set<import("node:child_process").ChildProcessWithoutNullStreams>} */
  const active = new Set()
  try {
    const setup = `mkdir -p ${quote(root + "/slot1")} ${quote(root + "/.farm")}; printf '%s\\n' '{"name":"devx-farm-fixture","private":true}' > ${quote(root + "/slot1/package.json")}; cd ${quote(root + "/slot1")}; export PATH="$HOME/.nvm/versions/node/${process.version}/bin:/opt/homebrew/bin:/usr/bin:/bin"; pnpm install --lockfile-only --ignore-scripts >/dev/null`
    await command(setup)
    const upload = spawn("ssh", [...ssh, host, `cat > ${quote(root + "/helper.sh")}`], { stdio: ["pipe", "ignore", "pipe"] })
    const uploaded = new Promise((resolve) => upload.once("close", resolve))
    upload.stdin.end(readFileSync(join(import.meta.dirname, "mini-remote.sh")))
    assert.equal(await uploaded, 0)
    /** @type {(source: string, cancel?: boolean) => Promise<{status: number | null, out: string, err: string}>} */
    const run = (source, cancel = false) => new Promise((resolve, reject) => {
      const args = ["env", `MINI_FARM_ROOT=${root}`, "bash", root + "/helper.sh", "1", process.version, ".", "0", "0", "--", "node", "-e", source]
      const child = spawn("ssh", [...ssh, host, args.map(quote).join(" ")], { stdio: ["pipe", "pipe", "pipe"] })
      active.add(child)
      let out = "", err = "", cancelled = false
      const timer = setTimeout(() => { child.stdin.end(); child.kill("SIGTERM"); reject(new Error(`Mini helper timed out: ${err}`)) }, 60000)
      child.stdout.on("data", (chunk) => {
        out += chunk
        if (cancel && !cancelled && out.includes("DEVX_READY")) { cancelled = true; child.stdin.end() }
      })
      child.stderr.on("data", (chunk) => { err += chunk })
      child.once("close", (status) => { clearTimeout(timer); active.delete(child); resolve({ status, out, err }) })
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
    })
    const success = await run('console.log("DEVX_OK", process.env.VITEST_MAX_WORKERS)')
    assert.equal(success.status, 0, success.err)
    assert.match(success.out, /DEVX_OK 2/)
    const failure = await run("process.exit(23)")
    assert.equal(failure.status, 23, failure.err)
    const cancelled = await run('console.log("DEVX_READY");setInterval(()=>{},1000)', true)
    assert.equal(cancelled.status, 143, cancelled.err)
    await command(`test -z "$(find ${quote(root + "/.farm")} -maxdepth 1 -name 's1.*' -print)"; for p in $(cat ${quote(root + "/.farm/slot1.groups")}); do if kill -0 -- -"$p" 2>/dev/null; then exit 1; fi; done`)
  } finally {
    if (active.size) { for (const child of active) { child.stdin.end(); child.kill("SIGTERM") } }
    else await command(`rm -rf -- ${quote(root)}`)
  }
})
