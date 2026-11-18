/**
 * GitHub Actions `${{ }}` expressions in an inventory's text.
 *
 * Generated targets run in a plain shell, so an expression becomes either its
 * matrix value or the environment variable GitHub documents for it. An
 * expression with no such form cannot run, and the caller reports the step.
 *
 * @since 0.1.0
 */

/**
 * One matrix assignment. Empty when the job has no matrix.
 *
 * @category models
 * @since 0.1.0
 */
export type Variant = Readonly<Record<string, string>>

const expression = /\$\{\{\s*(.*?)\s*\}\}/g
const reference = /^(matrix|env|secrets|vars|github|runner)\.[A-Za-z_][A-Za-z0-9_-]*$/
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/

const prefixes: ReadonlyMap<string, string> = new Map([
  ["env", ""],
  ["secrets", ""],
  ["vars", ""],
  ["github", "GITHUB_"],
  ["runner", "RUNNER_"]
])

const matrixValue = (variant: Variant, name: string): string | undefined =>
  Object.hasOwn(variant, name) ? variant[name] : undefined

const shellVariable = (context: string, name: string): string | undefined => {
  if (!variableName.test(name)) return undefined
  const prefix = prefixes.get(context) as string
  return `\${${prefix}${prefix === "" ? name : name.toUpperCase()}}`
}

const substitute = (
  text: string,
  resolve: (context: string, name: string) => string | undefined
): string | undefined => {
  let complete = true
  const result = text.replace(expression, (_match, inner: string) => {
    const dot = inner.indexOf(".")
    const value = reference.test(inner) ? resolve(inner.slice(0, dot), inner.slice(dot + 1)) : undefined
    if (value === undefined) complete = false
    return value ?? ""
  })
  return complete ? result : undefined
}

/**
 * Text a shell will read: matrix values are written in place and every other
 * known context becomes a variable. `undefined` when an expression has no
 * shell form.
 *
 * @category expressions
 * @since 0.1.0
 */
export const forShell = (text: string, variant: Variant): string | undefined =>
  substitute(text, (context, name) => context === "matrix" ? matrixValue(variant, name) : shellVariable(context, name))

/**
 * Text no shell reads, such as an environment value or a directory: only
 * matrix values can be written. `undefined` for any other expression.
 *
 * @category expressions
 * @since 0.1.0
 */
export const forText = (text: string, variant: Variant): string | undefined =>
  substitute(text, (context, name) => context === "matrix" ? matrixValue(variant, name) : undefined)
