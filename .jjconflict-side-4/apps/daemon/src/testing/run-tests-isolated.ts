import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"

const testArgs = process.argv.slice(2)
const tempDataRoot = mkdtempSync(path.join(tmpdir(), "burns-daemon-test-"))
let exitCode = 1

try {
  const subprocess = Bun.spawnSync([process.execPath, "test", ...testArgs], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BURNS_DATA_ROOT: tempDataRoot,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  exitCode = subprocess.exitCode
} finally {
  rmSync(tempDataRoot, { recursive: true, force: true })
}

process.exit(exitCode)
