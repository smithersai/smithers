/**
 * Value-free rendering of schema failures.
 *
 * A profile or skill file can carry a pasted credential in the wrong field,
 * so a decode failure is reported as the field path and what the field
 * expects, never the value found there.
 *
 * @since 1.0.0
 */
import type * as Schema from "effect/Schema"
import type * as SchemaIssue from "effect/SchemaIssue"

/**
 * One rejected field: its path and a value-free description of the problem.
 *
 * @private
 * @since 1.0.0
 */
export interface FieldProblem {
  readonly field: string
  readonly problem: string
}

const render = (segments: ReadonlyArray<PropertyKey>): string =>
  segments.reduce<string>(
    (path, segment) =>
      typeof segment === "number"
        ? `${path}[${segment}]`
        : path === ""
        ? String(segment)
        : `${path}.${String(segment)}`,
    ""
  )

const stringAnnotation = (annotations: unknown, key: string): string | undefined => {
  if (typeof annotations !== "object" || annotations === null) return undefined
  const value = (annotations as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

/**
 * Collects up to `limit` rejected fields from a schema error.
 *
 * @private
 * @since 1.0.0
 */
export const problems = (error: Schema.SchemaError, limit = 5): ReadonlyArray<FieldProblem> => {
  const found: Array<FieldProblem> = []
  const visit = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>, expected: string | undefined) => {
    if (found.length >= limit) return
    switch (issue._tag) {
      case "Pointer":
        return visit(issue.issue, [...path, ...issue.path], expected)
      case "Filter":
        return visit(
          issue.issue,
          path,
          stringAnnotation(issue.filter.annotations, "expected") ??
            stringAnnotation(issue.filter.annotations, "message")
        )
      case "Composite":
      case "AnyOf":
        if (issue.issues.length === 0) {
          found.push({ field: render(path), problem: "is not one of the accepted values" })
          return
        }
        for (const inner of issue.issues) visit(inner, path, expected)
        return
      case "MissingKey":
        found.push({ field: render(path), problem: "is required" })
        return
      case "UnexpectedKey":
        found.push({ field: render(path), problem: "is not a recognized key" })
        return
      case "InvalidValue": {
        const message = stringAnnotation(issue.annotations, "message")
        found.push({
          field: render(path),
          problem: message ?? (expected === undefined ? "is invalid" : `expected ${expected}`)
        })
        return
      }
      default:
        // InvalidType, and the transformation and union issues this package's
        // schemas do not produce, all mean "not this kind of value".
        found.push({ field: render(path), problem: "has the wrong type" })
    }
  }
  visit(error.issue, [], undefined)
  return found
}

/**
 * Renders collected problems as one sentence list.
 *
 * @private
 * @since 1.0.0
 */
export const summary = (found: ReadonlyArray<FieldProblem>): string =>
  found.map(({ field, problem }) => `${field === "" ? "value" : field} ${problem}`).join("; ")
