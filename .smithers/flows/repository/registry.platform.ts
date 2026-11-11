// The platform code of registry.vibe: file paths beside this module, which a .vibe file does not derive with node:url.
import { fileURLToPath } from "node:url"

/**
 * The file path of `relative`, resolved against this module's own directory.
 * The module is loaded from a `file:` URL, so the resolution cannot fail.
 * @throws {never}
 */
export function modulePath(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url))
}
