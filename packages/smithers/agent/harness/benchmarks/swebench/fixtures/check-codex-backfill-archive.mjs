/**
 * The codex backfill's archive, replayed over a copied rig with stub commands.
 *
 *   node fixtures/check-codex-backfill-archive.mjs
 *
 * `codex-backfill-dryrun.sh` proves the backfill against real docker; what it
 * cannot inject is an archive that fails. A copy that failed on a full disk,
 * followed by the delete, once destroyed a paid attempt's only patch and
 * transcript, graded nothing, and recorded `eval error` as the verdict — the
 * one row that makes a retry a no-op. So this runs the real script with the
 * agent, the evaluator, the auth check and docker stubbed, and `cp`, `ln` and
 * `mv` made to fail one at a time, and reads what the sources, the archive and
 * the ledger say afterwards: the sources are where the run wrote them, nothing
 * was published or graded, the row is `failed` with reason `archive-failed`
 * and no verdict, and the instance is still owed. A retry recovers the
 * sources before it runs, and an attempt that was archived but never reached
 * a verdict row is recovered with its evaluator report.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { queue } from "../lib/codex-backfill-queue.mjs"
import { readRows } from "../lib/fullbench-manifest.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-codex-backfill-archive-"))
const id = "archive__1"
const timings = "{\"wallClockSeconds\":7,\"testbedNetworkObserved\":\"bridge\"}"
const transcript = "tokens used\n12,345\n"

const rowsOf = (fb) =>
  readRows(join(fb, "codex-manifest.jsonl")).rows.filter((row) => row.kind === "instance" && row.id === id)
const last = (rows) => rows[rows.length - 1]
const owed = (fb) => queue(join(fb, "manifest.jsonl"), join(fb, "codex-manifest.jsonl")).remaining.map((row) => row.id)
const recoveredIn = (fbc) => readdirSync(join(fbc, "archives")).filter((name) => name.startsWith(`${id}.recovered-`))

/**
 * A copied rig: the script, its helpers, a one-instance population, and a
 * `bin/` ahead of PATH whose `cp`, `ln` and `mv` fail as `ARCHIVE_MODE` says.
 */
const makeRig = (name) => {
  const rig = join(temporary, name)
  const bin = join(rig, "bin")
  const fb = join(rig, "fullbench")
  const fbc = join(fb, "codex")
  mkdirSync(bin, { recursive: true })
  mkdirSync(fb, { recursive: true })
  cpSync(join(root, "lib"), join(rig, "lib"), { recursive: true })
  cpSync(join(root, "codex-backfill.sh"), join(rig, "codex-backfill.sh"))
  writeFileSync(
    join(fb, "manifest.jsonl"),
    `${
      [
        { kind: "header", at: 1, runId: "fullbench", index: "r90" },
        { kind: "instance", id, state: "cleaned", at: 2, verdict: "unresolved" }
      ].map((row) => JSON.stringify(row)).join("\n")
    }\n`
  )
  const script = (file, body) => writeFileSync(join(bin, file), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 })
  script("docker", "exit 0")
  script("auth", "exit 0")
  // The stub agent: everything run-instance-codex.sh leaves behind.
  script(
    "run",
    `
S="$RIG"
eval "$("$S/lib/run-paths.sh" codex "$1" "$4")"
mkdir -p "$WORK" "$PATCH_ROOT" "$TIMINGS_ROOT" "$LOG_ROOT"
printf 'paid patch' > "$PATCH"
printf 'untracked' > "$PATCH.untracked"
printf '%s' '${timings}' > "$TIMINGS"
printf 'tokens used\\n12,345\\n' > "$LOG_PREFIX.run.log"
printf 'last message' > "$LOG_PREFIX.last-message.txt"
printf 'prompt' > "$LOG_PREFIX.prompt.md"
`
  )
  // The stub evaluator: a report where the real one writes it, and a marker.
  script(
    "grade",
    `
DIR="$SWB_EVAL_LOG_ROOT/$1/codex-cli/$2"
mkdir -p "$DIR"
printf '{"%s": {"resolved": true}}' "$2" > "$DIR/report.json"
touch "$RIG/graded"
`
  )
  script(
    "cp",
    `
case "$ARCHIVE_MODE" in
  patch-fail) exit 1 ;;
  interrupted-copy) kill -TERM $$ ;;
  untracked-fail) case "$*" in *.untracked*) exit 1 ;; esac ;;
  timings-fail) case "$*" in *timings-codex/*) exit 1 ;; esac ;;
  log-fail) case "$*" in *.run.log*) exit 1 ;; esac ;;
  message-fail) case "$*" in *.last-message.txt*) exit 1 ;; esac ;;
  prompt-fail) case "$*" in *.prompt.md*) exit 1 ;; esac ;;
esac
/bin/cp "$@"
if [ "$ARCHIVE_MODE" = corrupt ]; then
  for last; do :; done
  if [ -f "$last" ]; then printf 'fake patch' > "$last"; fi
fi
`
  )
  script("ln", "if [ \"$ARCHIVE_MODE\" = link-fail ]; then exit 1; fi\n/bin/ln \"$@\"")
  // Publication is one rename: at that moment nothing under the familiar paths
  // resolves yet, and the sources are still where the run wrote them.
  script(
    "mv",
    `
for last; do :; done
case "$last" in
  */archives/${id})
    test ! -e "$FB_DIR/codex/patches/${id}.patch"
    test ! -e "$FB_DIR/codex/logs/${id}.run.log"
    test -f "$RIG/patches-codex/${id}-r90c.patch"
    test -f "$RIG/logs-codex/${id}-r90c.run.log"
    if [ "$ARCHIVE_MODE" = publish-fail ]; then exit 1; fi ;;
esac
/bin/mv "$@"
`
  )
  return { rig, bin, fb, fbc }
}

const run = ({ rig, bin, fb }, mode) => {
  const result = spawnSync("bash", [join(rig, "codex-backfill.sh"), "--lane", "net", "--one", id], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RIG: rig,
      ARCHIVE_MODE: mode,
      FB_DIR: fb,
      SWB_CODEX_RUN_CMD: join(bin, "run"),
      SWB_GRADE_CMD: join(bin, "grade"),
      SWB_CODEX_AUTH_CMD: join(bin, "auth"),
      SWB_DISK_FREE_MIB: "999999",
      SWB_FULLBENCH_PINNED: id,
      SWB_EVAL_LOG_ROOT: join(rig, "eval-logs")
    },
    encoding: "utf8",
    timeout: 60_000
  })
  assert.ifError(result.error)
  return result
}

/** What every archive failure must leave behind. */
const assertFailed = ({ rig, fb, fbc }, result, mode) => {
  assert.notEqual(result.status, 0, `${mode}: an archive failure must fail the instance`)
  assert.match(result.stdout, /FAILED: archive-failed/u, `${mode}: ${result.stdout}${result.stderr}`)
  // The sources are where the run wrote them.
  assert.equal(readFileSync(join(rig, "patches-codex", `${id}-r90c.patch`), "utf8"), "paid patch", `${mode}: patch`)
  assert.equal(readFileSync(join(rig, "patches-codex", `${id}-r90c.patch.untracked`), "utf8"), "untracked")
  assert.equal(readFileSync(join(rig, "timings-codex", `${id}-r90c.json`), "utf8"), timings)
  assert.equal(readFileSync(join(rig, "logs-codex", `${id}-r90c.run.log`), "utf8"), transcript, `${mode}: transcript`)
  assert.equal(readFileSync(join(rig, "logs-codex", `${id}-r90c.last-message.txt`), "utf8"), "last message")
  assert.equal(readFileSync(join(rig, "logs-codex", `${id}-r90c.prompt.md`), "utf8"), "prompt")
  // Nothing was published, nothing dangles, nothing was graded.
  assert.deepEqual(readdirSync(join(fbc, "archives")), [], `${mode}: no archive or staging directory is left`)
  assert.deepEqual(readdirSync(join(fbc, "patches")), [], `${mode}: no dangling patch link is left`)
  assert.deepEqual(readdirSync(join(fbc, "timings")), [], `${mode}: no dangling timings link is left`)
  assert.deepEqual(readdirSync(join(fbc, "logs")), [], `${mode}: no dangling log link is left`)
  assert.equal(existsSync(join(rig, "graded")), false, `${mode}: nothing was graded`)
  // The row says what happened and carries no verdict, so the instance is owed.
  const row = last(rowsOf(fb))
  assert.equal(row.state, "failed", `${mode}: ${JSON.stringify(row)}`)
  assert.equal(row.reason, "archive-failed")
  assert.equal(row.verdict, undefined, `${mode}: an archive failure is not a verdict`)
  assert.equal(rowsOf(fb).some((candidate) => candidate.state === "graded"), false)
  assert.deepEqual(owed(fb), [id], `${mode}: the instance is still owed an attempt`)
  // The claim was released: the next invocation can take it.
  assert.equal(existsSync(join(fbc, "claims", id, "pid")), false, `${mode}: the claim is released`)
}

try {
  for (
    const mode of [
      "patch-fail",
      "untracked-fail",
      "timings-fail",
      "log-fail",
      "message-fail",
      "prompt-fail",
      "interrupted-copy",
      "corrupt",
      "link-fail",
      "publish-fail"
    ]
  ) {
    const rig = makeRig(mode)
    assertFailed(rig, run(rig, mode), mode)
  }

  // -------------------------------------------------------------------------
  // A retry recovers the sources an archive failure left, then runs from the
  // top; a recovery that fails stops the retry with the sources untouched.
  // -------------------------------------------------------------------------
  const retried = makeRig("retry")
  assertFailed(retried, run(retried, "patch-fail"), "retry: first attempt")
  // Different contents distinguish the recovery from the fresh attempt.
  writeFileSync(join(retried.rig, "patches-codex", `${id}-r90c.patch`), "earlier paid patch")
  writeFileSync(join(retried.rig, "logs-codex", `${id}-r90c.run.log`), "earlier transcript")
  const stopped = run(retried, "patch-fail")
  assert.notEqual(stopped.status, 0, "a failed recovery stops the retry")
  assert.match(stopped.stdout, /FAILED: archive-failed/u)
  assert.equal(readFileSync(join(retried.rig, "patches-codex", `${id}-r90c.patch`), "utf8"), "earlier paid patch")
  assert.equal(readFileSync(join(retried.rig, "logs-codex", `${id}-r90c.run.log`), "utf8"), "earlier transcript")
  assert.deepEqual(recoveredIn(retried.fbc), [], "a failed recovery publishes nothing")
  assert.deepEqual(owed(retried.fb), [id])
  const recovered = run(retried, "success")
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr)
  const kept = recoveredIn(retried.fbc)
  assert.equal(kept.length, 1, "the retry kept the earlier attempt's evidence")
  assert.equal(readFileSync(join(retried.fbc, "archives", kept[0], "patch"), "utf8"), "earlier paid patch")
  assert.equal(readFileSync(join(retried.fbc, "archives", kept[0], "run.log"), "utf8"), "earlier transcript")
  assert.equal(readFileSync(join(retried.fbc, "patches", `${id}.patch`), "utf8"), "paid patch")
  assert.equal(last(rowsOf(retried.fb)).verdict, "resolved")
  assert.deepEqual(owed(retried.fb), [])

  // -------------------------------------------------------------------------
  // Success: the sources are gone, the familiar paths read the archived bytes
  // through links, and the row carries what it read off the archive.
  // -------------------------------------------------------------------------
  const published = makeRig("success")
  const success = run(published, "success")
  assert.equal(success.status, 0, success.stdout + success.stderr)
  assert.equal(existsSync(join(published.rig, "patches-codex", `${id}-r90c.patch`)), false, "the sources are deleted")
  assert.equal(existsSync(join(published.rig, "logs-codex", `${id}-r90c.run.log`)), false)
  assert.equal(existsSync(join(published.rig, "work-codex", `${id}-r90c`)), false)
  for (
    const [path, content] of [
      [join(published.fbc, "patches", `${id}.patch`), "paid patch"],
      [join(published.fbc, "patches", `${id}.patch.untracked`), "untracked"],
      [join(published.fbc, "timings", `${id}.json`), timings],
      [join(published.fbc, "logs", `${id}.run.log`), transcript],
      [join(published.fbc, "logs", `${id}.last-message.txt`), "last message"],
      [join(published.fbc, "logs", `${id}.prompt.md`), "prompt"]
    ]
  ) {
    assert.equal(readFileSync(path, "utf8"), content, path)
    assert.ok(lstatSync(path).isSymbolicLink(), `${path} is a link into the archive`)
  }
  assert.equal(readFileSync(join(published.fbc, "archives", id, "patch"), "utf8"), "paid patch")
  assert.equal(existsSync(join(published.rig, "graded")), true, "a published archive is graded")
  const graded = last(rowsOf(published.fb))
  assert.equal(graded.state, "graded")
  assert.equal(graded.verdict, "resolved")
  assert.equal(graded.patchBytes, 10)
  assert.equal(graded.tokens, 12345, "the token footer is read through the link")
  assert.equal(graded.agentSeconds, 7, "the agent's wall clock is read through the link")
  assert.equal(graded.testbedNetworkObserved, "bridge")
  assert.deepEqual(owed(published.fb), [])

  // -------------------------------------------------------------------------
  // Archived, then killed before the verdict row: the retry keeps that
  // attempt, evaluator report included, before it publishes its own.
  // -------------------------------------------------------------------------
  const ledger = join(published.fb, "codex-manifest.jsonl")
  writeFileSync(
    ledger,
    `${
      readFileSync(ledger, "utf8").split("\n").filter((line) => line !== "")
        .filter((line) => JSON.parse(line).state !== "graded").join("\n")
    }\n`
  )
  assert.deepEqual(owed(published.fb), [id], "without its verdict row the attempt is still owed")
  rmSync(join(published.rig, "graded"))
  const again = run(published, "success")
  assert.equal(again.status, 0, again.stdout + again.stderr)
  const unrecorded = recoveredIn(published.fbc)
  assert.equal(unrecorded.length, 1, "the unrecorded attempt was kept")
  assert.equal(readFileSync(join(published.fbc, "archives", unrecorded[0], "patch"), "utf8"), "paid patch")
  assert.equal(
    JSON.parse(readFileSync(join(published.fbc, "archives", unrecorded[0], "report.json"), "utf8"))[id].resolved,
    true,
    "with the report its grading wrote"
  )
  assert.equal(readFileSync(join(published.fbc, "patches", `${id}.patch`), "utf8"), "paid patch")
  assert.equal(existsSync(join(published.rig, "graded")), true, "and the retry graded its own attempt")
  assert.equal(last(rowsOf(published.fb)).verdict, "resolved")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log(
  "check-codex-backfill-archive.mjs: ten archive failures kept the sources, published nothing, graded nothing"
    + " and left the instance owed; a retry recovered them; an unrecorded attempt was kept with its report."
)
