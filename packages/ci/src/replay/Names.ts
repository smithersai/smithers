/**
 * File names a replay cannot hand to Smithers build.
 *
 * A file name on Linux and macOS is bytes. Smithers build reads every name of a
 * checkout as UTF-8 and stops a run at a name that is not, since reading it
 * as text would rename the file. So before it runs anything a replay reads
 * the names of every commit it replays, and of the commit its first run
 * starts from, and names the first one that is not UTF-8.
 *
 * Git prints a name that holds a byte outside printable ASCII in double
 * quotes, with C escapes: `"data/caf\351.txt"`. That text gives the bytes
 * back exactly, whatever they are, a newline included, and it is how the
 * replay shows such a name.
 *
 * @throws {never}
 * @since 0.1.0
 */

import { digestSync } from "@smthrs/crypto/Sha256"
import { isUtf8 } from "node:buffer"

/** The byte each escape git writes for a control character, a quote or a backslash stands for. */
const escapes: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  "\"": 34,
  "\\": 92
}

/**
 * The bytes of a name as git prints it: in double quotes with C escapes, or
 * as it is when it needs none.
 *
 * @category names
 * @since 0.1.0
 * @throws {never}
 */
export const bytesOf = (shown: string): Uint8Array => {
  if (!shown.startsWith("\"")) return new TextEncoder().encode(shown)
  const bytes: Array<number> = []
  let at = 1
  while (at < shown.length - 1) {
    const char = shown[at] as string
    const next = shown[at + 1] as string
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      at += 1
    } else if (next >= "0" && next <= "7") {
      // Git writes every other byte as three octal digits.
      bytes.push(Number.parseInt(shown.slice(at + 1, at + 4), 8))
      at += 4
    } else {
      bytes.push(escapes[next] as number)
      at += 2
    }
  }
  return Uint8Array.from(bytes)
}

/**
 * The first name of `listing`, one name a line as git prints them with
 * `core.quotePath`, whose bytes are not UTF-8: as git shows it.
 *
 * @category names
 * @since 0.1.0
 * @throws {never}
 */
export const notUtf8 = (listing: string): string | undefined =>
  listing.split("\n").find((shown) => shown !== "" && !isUtf8(bytesOf(shown)))

/**
 * Why a replay cannot run: a file of `commit` has a name that is not UTF-8.
 *
 * @category messages
 * @since 0.1.0
 * @throws {never}
 */
export const unreadableName = (shown: string, commit: string): string =>
  `the file ${shown} at ${commit.slice(0, 7)} has a name that is not UTF-8, which Smithers build cannot read; ` +
  "rename the file to replay this repository"

/**
 * Hex SHA-256 digest of a UTF-8 string.
 *
 * @category hashing
 * @throws {never}
 * @since 0.1.0
 */
export const sha256 = (text: string): string => digestSync(text)
