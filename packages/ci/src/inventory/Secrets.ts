/**
 * Keeps secret values out of an inventory. A secret is recorded by name only.
 *
 * @since 0.1.0
 */

const secretWords = "TOKEN|SECRET|PASSWORD|PASSWD|PGPASSWORD|API_?KEY|PRIVATE_KEY|ACCESS_KEY"

const valueShapes = [
  "\\bgh[pousr]_[A-Za-z0-9]{20,}",
  "\\bgithub_pat_[A-Za-z0-9_]{20,}",
  "\\bsk-[A-Za-z0-9_-]{20,}",
  "\\bxox[abprs]-[A-Za-z0-9-]{10,}",
  "\\bAKIA[0-9A-Z]{16}",
  "\\bnpm_[A-Za-z0-9]{30,}",
  "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
  // A password in a URL. One that starts with `$` is read from a variable.
  "[a-z][a-z0-9+.-]*://[^\\s/:@'\"]+:(?!\\$)[^\\s/@'\"]+@",
  // `API_TOKEN=abc ./deploy`. A value starting with `$` is read from a variable.
  `(?<![A-Za-z0-9_])(?:[A-Z0-9]+_)*(?:${secretWords})(?:_[A-Z0-9]+)*=["']?(?!\\$)[^\\s"';&|$]+`,
  "--(?:password|passwd|token|api-key)[= ][\"']?(?!\\$)[^\\s\"'$-][^\\s\"']*",
  "[Aa]uthorization:\\s*(?:Bearer|Basic|token)\\s+(?!\\$)[^\\s\"']+",
  "\\bmysql(?:dump)?\\b[^\\n|;&]*\\s-p(?!\\$)[^\\s\"']+"
].join("|")

const secretName =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|PGPASSWORD|PRIVATE_KEY|SECRET_KEY|SIGNING_KEY|ENCRYPTION_KEY|DEPLOY_KEY|SSH_KEY|API_?KEY|ACCESS_KEY|CREDENTIALS?|AUTH)(?:_|$)|_PWD$/i

/** A value that only names another variable or a matrix entry, and so holds nothing itself. */
const reference = /^(?:\$\{?\w+\}?|\$\{\{[^}]*\}\})$/

/**
 * True when text holds something shaped like a credential.
 *
 * @category secrets
 * @since 0.1.0
 * @throws {never}
 */
export const hasSecretValue = (text: string): boolean => new RegExp(valueShapes).test(text)

/**
 * True when a variable holding this written-out value is a secret: the value
 * has a credential's shape, or the name says it is one and the value is more
 * than a reference.
 *
 * @category secrets
 * @since 0.1.0
 * @throws {never}
 */
export const isLiteralSecret = (name: string, value: string): boolean =>
  hasSecretValue(value) || (secretName.test(name) && value !== "" && !reference.test(value))

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
