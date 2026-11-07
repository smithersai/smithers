// Retain the review's counterexamples: both suites must reject removal of either recovery mechanism.
// Run with no other build/test process writing this workspace. The source is restored in finally.
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const source = new URL("../src/web/main.vibe", import.meta.url)
const original = await readFile(source, "utf8")
const directory = process.env.VIBELANG_MUTATION_LOG_DIR ?? await mkdtemp(join(tmpdir(), "vl-recovery-"))
await mkdir(directory, { recursive: true })
const suites = [["runtime", ["exec", "vitest", "run", "test/recovery.runtime.test.vibe"]]]
if (process.argv.includes("--browser")) suites.push(["browser", ["exec", "playwright", "test", "e2e/recovery.spec.ts", "--project=dark", "--workers=1"]])
try {
  for (const mutation of ["gap", "reconnect"]) {
    const broken = mutation === "gap"
      ? original.replace(/^      if \(client\.gap\) return .*\n/m, "")
      : original.replace("epoch: model.epoch + 1, from: model.client.conversation.seq", "epoch: model.epoch, from: model.from")
    if (broken === original) throw new Error(`Mutation ${mutation} did not match the recovery code`)
    await writeFile(source, broken)
    for (const [suite, args] of suites) {
      const result = spawnSync("pnpm", args, { encoding: "utf8", timeout: 180_000 })
      const output = result.stdout + result.stderr
      const log = join(directory, `${mutation}-${suite}.log`)
      await writeFile(log, output)
      if (result.error || result.status !== 1 || !/1 failed/.test(output) || !/1 passed/.test(output)) {
        throw new Error(`${mutation}/${suite} did not reject exactly its affected behavior: ${log}`)
      }
      console.log(`Killed ${mutation}/${suite}: one failed, one passed (${log})`)
    }
  }
} finally {
  await writeFile(source, original)
}
