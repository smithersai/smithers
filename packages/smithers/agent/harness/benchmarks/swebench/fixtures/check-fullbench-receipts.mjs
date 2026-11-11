/**
 * Real worker receipts fail closed on filesystem write failures. The node
 * launcher replaces the selected ledger path with a directory, then runs the
 * real appender; every successful row still goes through its write and fsync implementation.
 * No Docker, dataset or model credentials are needed.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { isDone, read } from "../lib/fullbench-manifest.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "swebench-receipts-"))
const id = "receipt__1"
try {
  for (const target of ["pulled", "ran", "graded", "cleaned", "failed", "wait", "success"]) {
    const rig = join(temporary, target)
    const bin = join(rig, "bin")
    const fb = join(rig, "fullbench")
    mkdirSync(bin, { recursive: true })
    mkdirSync(fb)
    cpSync(join(root, "lib"), join(rig, "lib"), { recursive: true })
    const script = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 })
    const manifest = join(fb, "manifest.jsonl")
    const waits = join(fb, "waits.jsonl")
    writeFileSync(manifest, "")
    writeFileSync(waits, "")
    script(
      "node",
      `
if [[ "$1" = */manifest-append.mjs ]]; then
  if [[ "$3" = *\\\"state\\\":\\\"$FAIL_RECEIPT\\\"* || "$3" = *\\\"kind\\\":\\\"$FAIL_RECEIPT\\\"* ]]; then
    mv "$2" "$2.saved"
    mkdir "$2"
    touch "$RIG/write-failed"
    status=0
    "$REAL_NODE" "$@" || status=$?
    rmdir "$2"
    mv "$2.saved" "$2"
    exit "$status"
  fi
fi
exec "$REAL_NODE" "$@"
`
    )
    // The existing worker dry-run seams supply a patch and evaluator report.
    script(
      "run",
      `
touch "$RIG/ran"
if [ "$FAIL_RECEIPT" = failed ]; then exit 1; fi
eval "$("$RIG/lib/run-paths.sh" flows "$1" "$4")"
mkdir -p "$PATCH_ROOT" "$JOURNAL" "$TIMINGS_ROOT" "$LOG_ROOT"
printf "paid patch" > "$PATCH"
printf "paid journal" > "$JOURNAL/engine.db"
printf "{}" > "$TIMINGS"
printf "run log" > "$LOG_PREFIX.run.log"
`
    )
    script(
      "grade",
      `
touch "$RIG/graded"
report="$SWB_EVAL_LOG_ROOT/$1/flows-cell-harness/$2"
mkdir -p "$report"
printf "{\\\"$2\\\":{\\\"resolved\\\":true}}" > "$report/report.json"
`
    )
    script(
      "docker",
      `
printf "%s\\n" "$*" >> "$RIG/docker.log"
if [ "$FAIL_RECEIPT" = wait ] && [ "$1" = image ]; then exit 1; fi
`
    )
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REAL_NODE: process.execPath,
      RIG: rig,
      FAIL_RECEIPT: target,
      FB_DIR: fb,
      SWB_ARTIFACT_ROOT: rig,
      SWB_RUN_CMD: join(bin, "run"),
      SWB_GRADE_CMD: join(bin, "grade"),
      SWB_TRANSPORT: "docker",
      SWB_DISK_FREE_MIB: target === "wait" ? "0" : "999999",
      SWB_FULLBENCH_INDEX: "r90",
      SWB_FULLBENCH_PINNED: "",
      SWB_FULLBENCH_DISK_WAIT_MAX: "0",
      SWB_EVAL_LOG_ROOT: join(rig, "eval-logs")
    }
    const run = (environment) => {
      const result = spawnSync("bash", [join(rig, "lib", "fullbench-instance.sh"), id], {
        env: environment,
        encoding: "utf8",
        timeout: 30_000
      })
      assert.ifError(result.error)
      return result
    }
    const worker = run(env)
    const ledger = read(manifest)
    const states = ledger.rows.map((row) => row.state)
    if (target === "success") {
      assert.equal(worker.status, 0, worker.stderr)
      assert.deepEqual(states, ["pulled", "ran", "graded", "cleaned"])
      assert.equal(isDone(ledger.states.get(id)), true)
      continue
    }
    assert.equal(existsSync(join(rig, "write-failed")), true, `${target}: actual append was refused`)
    assert.notEqual(worker.status, 0, `${target}: failed append must fail the worker (states: ${states.join(",")})`)
    assert.match(worker.stderr, /could not persist/, `${target}: identifies the failed receipt`)
    if (target === "wait" || target === "pulled") {
      assert.deepEqual(states, [])
      assert.equal(existsSync(join(rig, "ran")), false)
    } else if (target === "failed") {
      assert.deepEqual(states, ["pulled"])
    } else {
      const expected = { ran: ["pulled"], graded: ["pulled", "ran"], cleaned: ["pulled", "ran", "graded"] }
      assert.deepEqual(states, expected[target])
      assert.equal(readFileSync(join(fb, "archives", id, "patch"), "utf8"), "paid patch")
      assert.equal(readFileSync(join(fb, "archives", id, "journal", "engine.db"), "utf8"), "paid journal")
      assert.equal(existsSync(join(rig, "graded")), target !== "ran")
      if (target !== "cleaned") {
        assert.doesNotMatch(readFileSync(join(rig, "docker.log"), "utf8"), /^rmi /m)
        assert.equal(isDone(ledger.states.get(id)), false)
      }
      if (target === "graded") {
        assert.equal(JSON.parse(readFileSync(join(fb, "reports", `${id}.json`), "utf8"))[id].resolved, true)
        const retry = run({ ...env, FAIL_RECEIPT: "success" })
        assert.equal(retry.status, 0, retry.stderr)
        const recovered = readdirSync(join(fb, "archives")).filter((name) => name.startsWith(`${id}.recovered-`))
        assert.equal(recovered.length, 1, "retry preserves the previous paid attempt")
        const archive = join(fb, "archives", recovered[0])
        assert.equal(readFileSync(join(archive, "patch"), "utf8"), "paid patch")
        assert.equal(readFileSync(join(archive, "journal", "engine.db"), "utf8"), "paid journal")
        assert.equal(JSON.parse(readFileSync(join(archive, "report.json"), "utf8"))[id].resolved, true)
      }
    }
  }
  for (const state of ["graded", "cleaned"]) {
    for (const verdict of [undefined, null, "", "unknown", true, {}]) {
      assert.equal(isDone({ state, verdict }), false, `${state}: missing or invalid verdict remains retryable`)
    }
    for (const verdict of ["resolved", "unresolved", "empty patch", "eval error"]) {
      assert.equal(isDone({ state, verdict }), true)
    }
  }
  console.log("check-fullbench-receipts: failed receipts stop advancement and preserve recoverable evidence")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
