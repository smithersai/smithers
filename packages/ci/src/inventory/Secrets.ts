/**
 * Keeps secret values out of an inventory. A secret is recorded by name only.
 *
 * @since 0.1.0
 */

const valueShapes = [
  "\\bgh[pousr]_[A-Za-z0-9]{20,}",
  "\\bgithub_pat_[A-Za-z0-9_]{20,}",
  "\\bsk-[A-Za-z0-9_-]{20,}",
  "\\bxox[abprs]-[A-Za-z0-9-]{10,}",
  "\\bAKIA[0-9A-Z]{16}",
  "\\bnpm_[A-Za-z0-9]{30,}",
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  // A password in a URL. `$` is left out so `://user:$PASSWORD@host` stays readable.
  "[a-z][a-z0-9+.-]*://[^\\s/:@'\"]+:[^\\s/@'\"$]+@"
].join("|")

const secretName = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_?KEY|ACCESS_KEY|CREDENTIALS?|AUTH)(?:_|$)/i

/**
 * True when text holds something shaped like a credential.
 *
 * @category secrets
 * @since 0.1.0
 * @throws {never}
 */
export const hasSecretValue = (text: string): boolean => new RegExp(valueShapes).test(text)

/**
 * True when an environment variable holding this literal value is a secret:
 * its value has a credential's shape, or its name says it is one and the value
 * is written out rather than read from another variable.
 *
 * @category secrets
 * @since 0.1.0
 * @throws {never}
 */
export const isLiteralSecret = (name: string, value: string): boolean =>
  hasSecretValue(value) || (secretName.test(name) && value !== "" && !value.includes("$"))

/**
 * Replaces everything shaped like a credential, in every string and mapping
 * key of a document.
 *
 * @category secrets
 * @since 0.1.0
 * @throws {never}
 */
export const scrub = <A>(value: A): A => scrubValue(value) as A

const scrubText = (text: string): string => text.replace(new RegExp(valueShapes, "g"), "[withheld]")

const scrubValue = (value: unknown): unknown => {
  if (typeof value === "string") return scrubText(value)
  if (Array.isArray(value)) return value.map(scrubValue)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrubText(key), scrubValue(item)]))
}
