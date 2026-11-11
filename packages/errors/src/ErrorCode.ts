/**
 * The error codes Smithers integration adapters raise, and their documentation.
 *
 * The table is the runtime source of truth: {@link SmithersErrorCode} is
 * derived from its keys, so the set of codes is closed. Smithers 0.x carried
 * 180 codes for an engine that no longer exists; 1.0 keeps only the ones the
 * `@smthrs/integrations` trees actually raise, because every other package
 * states its failures as `Schema.TaggedError` classes of its own.
 *
 * @since 1.0.0
 */

/**
 * The documentation page every code points at.
 *
 * This URL is appended to the message of every `SmithersError`, so it reaches
 * a user in a log line they cannot edit. It points at the package-owned
 * Markdown reference on GitHub.
 *
 * @category constants
 * @since 1.0.0
 */
export const ERROR_REFERENCE_URL =
  "https://github.com/smithersai/smithers/blob/main/packages/errors/docs/reference/error-codes.md"

/**
 * What a code means and when it is raised.
 *
 * @category models
 * @since 1.0.0
 */
export interface SmithersErrorDefinition {
  readonly when: string
  readonly details?: string
}

/**
 * Every known code, with the condition that raises it.
 *
 * @category models
 * @since 1.0.0
 */
export const smithersErrorDefinitions = {
  INVALID_INPUT: {
    when: "An integration signal service or event segment is empty after trimming or contains a colon.",
    details: "`{ service: value }` or `{ event: value }`, naming the invalid segment"
  },
  INTEGRATION_ERROR: {
    when:
      "An integration client, webhook source, or listener reconciliation fails. `reason` classifies the failure so a caller can map it to a transport status.",
    details: "{ reason, ...providerSafeDetails }"
  }
} as const satisfies Record<string, SmithersErrorDefinition>

Object.freeze(smithersErrorDefinitions)
for (const definition of Object.values(smithersErrorDefinitions)) Object.freeze(definition)

/**
 * A code carried by a `SmithersError`. The union is derived from the keys of
 * `smithersErrorDefinitions`, so the set is closed; a consumer that needs a
 * new code adds a row to `smithersErrorDefinitions` and regenerates the
 * reference page in the same edit.
 *
 * @category models
 * @since 1.0.0
 */
export type SmithersErrorCode = keyof typeof smithersErrorDefinitions

/**
 * Every documented code, in declaration order.
 *
 * @category models
 * @since 1.0.0
 */
export const smithersErrorCodes: ReadonlyArray<SmithersErrorCode> = Object.keys(
  smithersErrorDefinitions
) as Array<SmithersErrorCode>

Object.freeze(smithersErrorCodes)

/**
 * Whether `code` is one this package documents.
 *
 * @param code - Any value to classify; inherited keys and non-strings are rejected.
 * @returns Whether the value is an own key of the frozen catalog.
 * @category refinements
 * @since 1.0.0
 */
export const isSmithersErrorCode = (code: unknown): code is SmithersErrorCode =>
  typeof code === "string" && Object.hasOwn(smithersErrorDefinitions, code)

/**
 * The definition for `code`, or `undefined` when it is not a documented code.
 *
 * @param code - Any value to look up in the closed catalog.
 * @returns The frozen definition itself, or `undefined` for an unknown value.
 * @category getters
 * @since 1.0.0
 */
export const getSmithersErrorDefinition = (code: unknown): SmithersErrorDefinition | undefined =>
  isSmithersErrorCode(code) ? smithersErrorDefinitions[code] : undefined
