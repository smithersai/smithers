import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import * as Store from "../src/internal/PrivateStore.ts"

it.runIf(process.platform !== "win32")(
  "restricts existing Unix store modes and skips unsupported Windows chmod",
  () => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "private-store-platform-"))
    try {
      Fs.chmodSync(directory, 0o755)
      expect(Store.ensure(directory, Fs, "win32")).toBe(Fs.realpathSync(directory))
      expect(Fs.statSync(directory).mode & 0o777).toBe(0o755)
      expect(Store.ensure(directory, Fs, "linux")).toBe(Fs.realpathSync(directory))
      expect(Fs.statSync(directory).mode & 0o777).toBe(0o700)
    } finally {
      Fs.rmSync(directory, { recursive: true, force: true })
    }
  }
)
