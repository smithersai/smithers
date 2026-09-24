/** Native payload checks shared by installed-package smoke and tarball tests. */
import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { join } from "node:path"

export const nativeHelperFiles = [
  ["darwin-arm64", "smithers-jj-export"],
  ["darwin-x64", "smithers-jj-export"],
  ["linux-arm64", "smithers-jj-export"],
  ["linux-x64", "smithers-jj-export"],
  ["win32-x64", "smithers-jj-export.exe"]
]

/** An early rehearsal may have no helpers; partial or required bundles must be complete. */
export const verifyPackagedNativeHelpers = async (nativePackage, required = false) => {
  if (!required && !existsSync(join(nativePackage, "bin"))) return false
  for (const [platform, filename] of nativeHelperFiles) {
    const binary = join(nativePackage, "bin", platform, filename)
    const info = await stat(binary)
    if (!info.isFile()) throw new Error(`Installed native helper is not a regular file: ${binary}`)
  }
  return true
}
