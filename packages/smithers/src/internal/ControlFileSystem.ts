/** Private filesystem configuration shared by the native control hosts.
 * @since 1.0.0
 */
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { isAbsolute } from "node:path"

/** Select the interpreter by operator configuration, never PATH discovery.
 * @since 1.0.0
 * @private
 */
export const layer = (): typeof AtomicFileSystem.layer => {
  const executable = process.env.SMITHERS_PYTHON3
  if (executable === undefined || executable === "") return AtomicFileSystem.layer
  if (!isAbsolute(executable)) {
    throw new Error("SMITHERS_PYTHON3 must be an absolute path to a CPython 3 interpreter")
  }
  return AtomicFileSystem.layerWith({ executable })
}
