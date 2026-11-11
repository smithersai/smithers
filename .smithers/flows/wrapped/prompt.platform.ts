// The platform code of prompt.vibe: hashing and path arithmetic, which a .vibe file does not reach directly.
import { createHash } from "node:crypto"
import { join } from "node:path"

/**
 * The hex SHA-256 of `text`'s UTF-8 bytes.
 * @throws {never}
 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/**
 * `<cwd>/.flows/wrapped/extra/<digest>.md`: content-addressed, so a later launch never rewrites it.
 * @throws {never}
 */
export function promptPath(cwd: string, digest: string): string {
  return join(cwd, ".flows", "wrapped", "extra", `${digest}.md`)
}
