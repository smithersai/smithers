/**
 * Runs one kernel with a planted bug through the package's detectors and says
 * which ones notice. Used by `scripts/mutants.ts`.
 *
 *   node scripts/mutant-check.ts <directory holding the mutated src/Kernel.ts>
 *
 * Exits 1 and prints the detectors that noticed; exits 0 when none did.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { trace } from "../test/support/Generate.ts"
import type { Kernel } from "../test/support/Theorems.ts"
import { broken, steps } from "../test/support/Theorems.ts"

const directory = process.argv[2]
if (directory === undefined) {
  process.stderr.write("usage: node scripts/mutant-check.ts <src directory>\n")
  process.exit(2)
}

const kernel = (await import(pathToFileURL(join(directory, "Kernel.ts")).href)) as Kernel & {
  readonly replay: (lines: ReadonlyArray<string>) => ReadonlyArray<string>
}

const fixture: { readonly firstSeed: number; readonly length: number; readonly digests: ReadonlyArray<string> } = JSON
  .parse(readFileSync(new URL("../test/fixtures/reference.json", import.meta.url), "utf8"))

const noticed: Array<string> = []
try {
  const differing = fixture.digests.findIndex((expected, index) =>
    createHash("sha256")
      .update(kernel.replay(trace(fixture.firstSeed + index, fixture.length)).map((line) => line + "\n").join(""))
      .digest("hex") !== expected
  )
  if (differing !== -1) noticed.push(`reference digest (seed ${fixture.firstSeed + differing})`)
  noticed.push(...broken(kernel, steps(kernel, 120, 120)))
} catch (error) {
  noticed.push(`crash: ${String(error).split("\n")[0]}`)
}

process.stdout.write(noticed.join("; ") + "\n")
process.exit(noticed.length === 0 ? 0 : 1)
