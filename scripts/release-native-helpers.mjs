/** Native payload checks shared by installed-package smoke and tarball tests. */
import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { join } from "node:path"

/** An early rehearsal may have no helpers; partial or required bundles must be complete. */
export const verifyPackagedNativeHelpers = async (nativePackage, required = false) => {
  if (!required && !existsSync(join(nativePackage, "bin"))) return false
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
    const binary = join(nativePackage, "bin", platform, "smithers-jj-export")
    const info = await stat(binary)
    if (!info.isFile()) throw new Error(`Installed native helper is not a regular file: ${binary}`)
  }
  return true
}
