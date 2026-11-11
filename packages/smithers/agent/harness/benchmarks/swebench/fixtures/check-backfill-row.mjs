/**
 * `codex-backfill.sh` evals `codex-backfill-queue.mjs --row <id>`, and two of
 * its lines carry verdict strings read off the flows and codex ledgers. A
 * recognized flows verdict survives `eval`; malformed flows verdicts are
 * refused. A codex verdict remains data: it comes back byte for byte and runs
 * nothing.
 *
 *   node fixtures/check-backfill-row.mjs
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "swb-backfill-row-"))
try {
  const marker = join(temporary, "injected")
  const hostile = [
    `x"; touch ${marker}; echo "`,
    `$(touch ${marker})`,
    `\`touch ${marker}\``,
    `\\"; touch ${marker} #`,
    `'; touch ${marker}; '`,
    `a\ntouch ${marker}\n`,
    `$HOME \${IFS} !! *`
  ]
  for (const verdict of hostile) {
    for (const flowsVerdict of ["eval error", verdict]) {
      const manifest = join(temporary, "manifest.jsonl")
      const codexManifest = join(temporary, "codex-manifest.jsonl")
      writeFileSync(
        manifest,
        `${JSON.stringify({ kind: "instance", id: "acme__x-1", state: "graded", verdict: flowsVerdict })}\n`
      )
      writeFileSync(codexManifest, `${JSON.stringify({ kind: "instance", id: "acme__x-1", verdict })}\n`)
      const script = [
        `eval "$(node "$1" "$2" "$3" --row acme__x-1)"`,
        `printf '%s\\0%s\\0%s' "$BACKFILL_STATE" "$FLOWS_VERDICT" "$CODEX_VERDICT"`
      ].join("\n")
      const run = spawnSync(
        "bash",
        ["-c", script, "bash", join(root, "lib", "codex-backfill-queue.mjs"), manifest, codexManifest],
        { encoding: "utf8" }
      )
      assert.equal(run.status, 0, run.stderr)
      assert.ok(!existsSync(marker), `the verdict ${JSON.stringify(verdict)} ran a command`)
      const valid = flowsVerdict === "eval error"
      assert.deepEqual(
        run.stdout.split("\0"),
        [valid ? "done" : "unknown", valid ? flowsVerdict : "", verdict],
        "only recognized flows verdicts enter the population; codex data survives eval byte for byte"
      )
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

console.log("check-backfill-row.mjs: invalid flows verdicts are refused and hostile codex verdicts remain data.")
