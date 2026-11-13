/** Offline regressions for selection publication, disk destinations, scoring and dry-run ownership. */
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { renderCheckpoint, renderReport, summarise } from "../fullbench-report.mjs"

const root = resolve(import.meta.dirname, "..")
const script = (path, body) => writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 })
const run = (path, args, env) => spawnSync(path, args, { encoding: "utf8", env: { ...process.env, ...env } })

test("matrix grading refuses failed selection and publishes only complete current sets", () => {
  const temporary = mkdtempSync(join(tmpdir(), "swebench-selection-"))
  try {
    const rig = join(temporary, "rig")
    const artifacts = join(temporary, "artifacts")
    mkdirSync(rig)
    mkdirSync(artifacts)
    cpSync(join(root, "grade-matrix.sh"), join(rig, "grade-matrix.sh"))
    cpSync(join(root, "lib"), join(rig, "lib"), { recursive: true })
    symlinkSync(join(root, "select-candidate.mjs"), join(rig, "select-candidate.mjs"))
    const ids = ["astropy__astropy-8707", "django__django-16612"]
    writeFileSync(join(rig, "sample.json"), JSON.stringify({ instances: ids }))
    script(join(rig, "evaluate.sh"), "printf \"%s\n\" \"$1\" >> \"$RECEIPTS\"")
    const selected = join(artifacts, "selected")
    mkdirSync(selected)
    writeFileSync(join(selected, "stale__1.patch"), "OLD PATCH")
    const receipts = join(temporary, "receipts")
    const env = { SWB_ARTIFACT_ROOT: artifacts, SWB_SAMPLE_COUNT: "2", RECEIPTS: receipts }
    for (const group of ["selected", "all", "select"]) {
      const failed = run("bash", [join(rig, "grade-matrix.sh"), "new-wave", group, "1"], env)
      assert.notEqual(failed.status, 0)
      assert.ok(!existsSync(receipts), `${group} graded after selection failed: ${failed.stdout}`)
      assert.equal(readFileSync(join(selected, "stale__1.patch"), "utf8"), "OLD PATCH")
    }

    const hydrated = run(process.execPath, [
      join(root, "fixtures/rehydrate-journals.mjs"),
      join(root, "fixtures/wave11-journals.json"),
      join(artifacts, "journals"),
      "r1",
      join(artifacts, "patches")
    ])
    assert.equal(hydrated.status, 0, hydrated.stderr)
    // The second requested instance fails after the first has selected.
    const missing = join(artifacts, "journals", `${ids[1]}-r1`)
    const saved = join(artifacts, "saved-journal")
    cpSync(missing, saved, { recursive: true })
    rmSync(missing, { recursive: true })
    const partial = run("bash", [join(rig, "grade-matrix.sh"), "partial-wave", "selected"], env)
    assert.notEqual(partial.status, 0)
    assert.ok(!existsSync(receipts), "a partial selection never reaches grading")
    assert.ok(!existsSync(join(selected, `${ids[0]}.patch`)), "partial output was not published")
    cpSync(saved, missing, { recursive: true })

    const complete = run("bash", [join(rig, "grade-matrix.sh"), "complete-wave", "selected"], env)
    assert.equal(complete.status, 0, `${complete.stdout}\n${complete.stderr}`)
    assert.equal(readFileSync(receipts, "utf8"), "complete-wave-selected\n")
    assert.ok(!existsSync(join(selected, "stale__1.patch")), "old population is removed on publication")
    for (const id of ids) {
      assert.ok(existsSync(join(selected, `${id}.patch`)))
      const rationale = JSON.parse(readFileSync(join(selected, `${id}.rationale.json`), "utf8"))
      assert.equal(rationale.selectedPatch, join(selected, `${id}.patch`), "rationale names the published patch")
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test("selection publication restores the prior set on a failed rename", () => {
  const temporary = mkdtempSync(join(tmpdir(), "swebench-publication-"))
  try {
    const rig = join(temporary, "rig")
    mkdirSync(join(rig, "lib"), { recursive: true })
    cpSync(join(root, "lib/publish-selection.mjs"), join(rig, "lib/publish-selection.mjs"))
    const publish = join(rig, "lib/publish-selection.mjs")
    const stage = join(rig, "stage")
    const current = join(stage, "current")
    mkdirSync(current, { recursive: true })
    writeFileSync(join(current, "new__1.patch"), "NEW PATCH")
    writeFileSync(join(current, "new__1.rationale.json"), JSON.stringify({ instance: "new__1" }))
    const selected = join(rig, "selected")
    const first = run(process.execPath, [publish, stage, selected])
    assert.equal(first.status, 0, first.stderr)
    assert.equal(
      JSON.parse(readFileSync(join(selected, "new__1.rationale.json"))).selectedPatch,
      "selected/new__1.patch"
    )

    mkdirSync(current)
    const impossibleDestination = join(current, "selected")
    mkdirSync(impossibleDestination)
    writeFileSync(join(impossibleDestination, "old.patch"), "KEEP PATCH")
    // Renaming a directory into itself is rejected by the real filesystem.
    const failed = run(process.execPath, [publish, stage, impossibleDestination])
    assert.notEqual(failed.status, 0)
    assert.equal(readFileSync(join(impossibleDestination, "old.patch"), "utf8"), "KEEP PATCH")
    assert.ok(!existsSync(join(stage, "previous")), "the old set was restored")
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test("disk admission measures workspace and archive destinations and the Docker minimum", () => {
  const temporary = mkdtempSync(join(tmpdir(), "swebench-disk-"))
  try {
    const bin = join(temporary, "bin")
    const artifacts = join(temporary, "artifacts")
    const archive = join(temporary, "archive")
    for (const path of [bin, artifacts, archive]) mkdirSync(path)
    const record = join(temporary, "df-paths")
    script(
      join(bin, "df"),
      `
printf '%s\n' "$2" >> "$DF_RECORD"
[ "\${DF_FAILURE:-0}" = 0 ] || exit 1
FREE=20480000
case "$2" in
  "$SWB_ARTIFACT_ROOT"*) FREE="$WORK_FREE" ;;
  "$ARCHIVE_PARENT"*) FREE="$ARCHIVE_FREE" ;;
esac
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'
printf 'fixture 99999999 1 %s 1%% /\\n' "$FREE"
`
    )
    script(
      join(bin, "docker"),
      `
if [ "$1" = image ]; then [ -n "\${PROBE_FREE:-}" ]; exit; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'
printf 'fixture 99999999 1 %s 1%% /\\n' "$PROBE_FREE"
`
    )
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      SWB_ARTIFACT_ROOT: artifacts,
      FB_DIR: join(archive, "not-created", "fullbench"),
      ARCHIVE_PARENT: archive,
      DF_RECORD: record,
      WORK_FREE: "4096000",
      ARCHIVE_FREE: "3072000",
      SWB_DISK_FREE_MIB: ""
    }
    for (
      const [work, archived, probe, expected] of [
        ["4096000", "3072000", "", "3000"],
        ["2048000", "3072000", "", "2000"],
        ["0", "3072000", "", "0"],
        ["20480000", "30720000", "1024000", "1000"]
      ]
    ) {
      const result = run("bash", [join(root, "lib/disk-free.sh")], {
        ...env,
        WORK_FREE: work,
        ARCHIVE_FREE: archived,
        PROBE_FREE: probe
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), expected)
    }
    const unreadable = run("bash", [join(root, "lib/disk-free.sh")], { ...env, DF_FAILURE: "1" })
    assert.notEqual(unreadable.status, 0, "an unreadable destination cannot admit a pull")
    const paths = readFileSync(record, "utf8").trim().split("\n")
    assert.ok(paths.includes(artifacts), "missing work root resolves to its existing parent")
    assert.ok(paths.includes(archive), "missing archive resolves to its existing parent")
    const explained = run("bash", [join(root, "lib/disk-free.sh"), "--explain"], env)
    assert.match(explained.stdout, /workspace.*archive/)
    const overridden = run("bash", [join(root, "lib/disk-free.sh")], { ...env, SWB_DISK_FREE_MIB: "7" })
    assert.equal(overridden.stdout.trim(), "7")
    const malformed = run("bash", [join(root, "lib/disk-free.sh")], { ...env, WORK_FREE: "unknown" })
    assert.notEqual(malformed.status, 0, "a malformed filesystem reading cannot admit a pull")
    symlinkSync(archive, join(artifacts, "work"))
    const mounted = run("bash", [join(root, "lib/disk-free.sh")], env)
    assert.equal(mounted.stdout.trim(), "3000", "an existing symlinked workspace is measured at its destination")
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test("status and checkpoints disclose scored and raw denominators including zero scored", () => {
  const temporary = mkdtempSync(join(tmpdir(), "swebench-scoring-"))
  try {
    const manifest = join(temporary, "manifest.jsonl")
    const excluded = "psf__requests-1766"
    const row = (id, verdict) => ({ kind: "instance", id, verdict, state: "graded", at: 1 })
    for (
      const rows of [
        [row("scored__1", "resolved"), row(excluded, "unresolved")],
        [row(excluded, "resolved")],
        []
      ]
    ) {
      writeFileSync(manifest, rows.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
      const summary = summarise({ manifest, now: 10, total: rows.length })
      const status = run(process.execPath, [
        join(root, "lib/fullbench-status.mjs"),
        manifest,
        join(temporary, "absent.json"),
        "stopped",
        "4096"
      ])
      assert.equal(status.status, 0, status.stderr)
      const checkpoint = renderCheckpoint(summary)
      for (const rendered of [status.stdout, checkpoint]) {
        assert.match(rendered, new RegExp(`${summary.scoredGraded} scored of ${summary.graded} run`))
        if (summary.scoredGraded > 0) {
          assert.match(rendered, /100\.0%/)
          assert.doesNotMatch(rendered, /50\.0%/)
        } else {
          assert.match(rendered, /no scored instances|no rate/i)
          assert.doesNotMatch(rendered, /0\.0%/)
        }
        if (rows.length > 0) assert.ok(rendered.includes(excluded), "exclusions are named")
      }
      if (summary.scoredGraded === 0) assert.match(renderReport(summary), /no rate/i)
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test("concurrent dry-run startup and cleanup own distinct files and image tags", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "swebench-dryrun-isolation-"))
  try {
    const rig = join(temporary, "rig")
    const bin = join(temporary, "bin")
    const rendezvous = join(temporary, "rendezvous")
    for (const path of [rig, bin, rendezvous]) mkdirSync(path)
    cpSync(join(root, "fullbench-dryrun.sh"), join(rig, "fullbench-dryrun.sh"))
    cpSync(join(root, "lib"), join(rig, "lib"), { recursive: true })
    const sentinel = join(rig, "patches", "stubfull__one-r90.patch")
    mkdirSync(join(rig, "patches"))
    writeFileSync(sentinel, "foreign evidence")
    // The unavailable Docker boundary records mutations, then fails startup
    // only after both invocations have reached it. No daemon or model is used.
    script(
      join(bin, "docker"),
      `
printf '%s\\n' "$*" >> "$RENDEZVOUS/$INVOCATION.commands"
if [ "$1" = image ] && [ "$2" = inspect ]; then exit 1; fi
if [ "$1" = pull ]; then
  printf '%s\\n' "\${SWB_ARTIFACT_ROOT:-unset}" > "$RENDEZVOUS/$INVOCATION.root"
  touch "$RENDEZVOUS/$INVOCATION.ready"
  for N in $(seq 1 100); do
    [ -f "$RENDEZVOUS/one.ready" ] && [ -f "$RENDEZVOUS/two.ready" ] && exit 1
    sleep 0.05
  done
  exit 2
fi
`
    )
    const launch = (name) =>
      new Promise((resolveRun, reject) => {
        const child = spawn("bash", [join(rig, "fullbench-dryrun.sh")], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TMPDIR: temporary,
            RENDEZVOUS: rendezvous,
            INVOCATION: name,
            SWB_DRYRUN_KEEP: "1",
            SWB_ARTIFACT_ROOT: temporary
          }
        })
        let output = ""
        child.stdout.on("data", (part) => {
          output += part
        })
        child.stderr.on("data", (part) => {
          output += part
        })
        child.on("error", reject)
        child.on("close", (status) => resolveRun({ status, output }))
      })
    const results = await Promise.all([launch("one"), launch("two")])
    for (const result of results) assert.equal(result.status, 1, result.output)
    const roots = ["one", "two"].map((name) => readFileSync(join(rendezvous, `${name}.root`), "utf8").trim())
    assert.notEqual(roots[0], roots[1], "each invocation exports its own artifact root")
    for (const artifact of roots) assert.ok(artifact.startsWith(temporary) && artifact !== temporary)
    assert.equal(readFileSync(sentinel, "utf8"), "foreign evidence", "cleanup preserves shared checkout artifacts")
    const removed = ["one", "two"].map((name) =>
      readFileSync(join(rendezvous, `${name}.commands`), "utf8").split("\n").filter((line) => line.startsWith("rmi "))
    )
    for (const commands of removed) {
      assert.ok(commands.length > 0, "cleanup removes only its private tags even after startup failure")
      for (const command of commands) {
        assert.doesNotMatch(command, /(?:^| )(?:busybox|hello-world|alpine):latest(?: |$)/)
      }
    }
    assert.ok(removed[0].every((line) => !removed[1].includes(line)), "cleanup image sets do not overlap")
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
