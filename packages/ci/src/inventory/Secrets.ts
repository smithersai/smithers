/**
 * Keeps secret values out of an inventory. A secret is recorded by name only.
 *
 * @since 0.1.0
 */

const secretWords =
  "TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PGPASSWORD|PRIVATE_KEY|SECRET_KEY|SIGNING_KEY|ENCRYPTION_KEY|DEPLOY_KEY|SSH_KEY|API_?KEY|ACCESS_KEY|CREDENTIALS?"

/** A last name part saying the variable describes a secret and does not hold one, as `TOKEN_FILE` does. */
const describingParts =
  "FILE|PATH|NAME|LIMIT|URL|DIR|ID|TTL|COUNT|SIZE|HEADER|ENV|VAR|LENGTH|TYPE|MAX|MIN|ENABLED|REQUIRED|EXPIRY|TIMEOUT|PREFIX|SUFFIX"

/** What follows `NAME=` in a command when the value is written out, not read from a variable. */
const writtenValue = `=["']?(?!\\$)[^\\s"';&|$]+`

const valueShapes = [
  "\\bgh[pousr]_[A-Za-z0-9]{20,}",
  "\\bgithub_pat_[A-Za-z0-9_]{20,}",
  "\\bsk-[A-Za-z0-9_-]{20,}",
  "\\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}",
  "\\bxox[abprs]-[A-Za-z0-9-]{10,}",
  "\\bAKIA[0-9A-Z]{16}",
  "\\bnpm_[A-Za-z0-9]{30,}",
  "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
  // A password in a URL. One that starts with `$` is read from a variable.
  "[a-z][a-z0-9+.-]*://[^\\s/:@'\"]+:(?!\\$)[^\\s/@'\"]+@",
  // `API_TOKEN=abc ./deploy`, in a command, where `$` does read a variable.
  `(?<![A-Za-z0-9_])(?:[A-Z0-9]+_)*(?:${secretWords})(?:_(?!(?:${describingParts})=)[A-Z0-9]+)*${writtenValue}`,
  `(?<![A-Za-z0-9_])(?:[A-Z0-9]+_)+(?:PASS|PWD|AUTH)${writtenValue}`,
  `(?<![A-Za-z0-9_])(?:[a-z0-9]+_)*(?:token|secret|password|passwd|passphrase|api_?key)${writtenValue}`,
  "--(?:password|passwd|token|api-key)[= ][\"']?(?!\\$)[^\\s\"'$-][^\\s\"']*",
  "[Aa]uthorization:\\s*(?:Bearer|Basic|token)\\s+(?!\\$)[^\\s\"']+",
  "[Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy]:\\s*(?!\\$)[^\\s\"']+",
  "\\bcurl\\b[^\\n|;&]*\\s(?:-u|--user)[ =][\"']?[^\\s\"':$]+:(?!\\$)[^\\s\"']+",
  "\\bmysql(?:dump)?\\b[^\\n|;&]*\\s-p(?!\\$)[^\\s\"']+"
].join("|")

const secretName = new RegExp(`(?:^|_)(?:${secretWords})(?:_|$)|[a-z0-9]token$|_(?:pass|pwd|auth)$`, "i")
const describingName = new RegExp(`_(?:${describingParts})$`, "i")

/** A value that is a workflow expression, and so holds nothing itself. */
const reference = /^\$\{\{[^}]*\}\}$/

/**
 * True when a variable's name says it holds a secret.
 *
 * @category secrets
 * @since 0.1.0
 * @throws {never}
 */
export const isSecretName = (name: string): boolean => secretName.test(name) && !describingName.test(name)

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
 * has a credential's shape, or the name says it is one. CI files do not expand
 * `$NAME` in these values, so only a workflow expression holds nothing.
 *
 * @category secrets
 * @since 0.1.0
 * @throws {never}
 */
export const isLiteralSecret = (name: string, value: string): boolean =>
  hasSecretValue(value) || (isSecretName(name) && value !== "" && !reference.test(value))

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
