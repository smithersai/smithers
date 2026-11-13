/**
 * Source locations for parsed or host-constructed YAML nodes and failures.
 * @since 1.0.0
 */

import type * as Yaml from "yaml"

/**
 * Reports the first source line when a node has not yet received a parser range.
 * @category diagnostics
 * @since 1.0.0
 */
export const nodeLine = (counter: Yaml.LineCounter, node: unknown): number => {
  const range = (node as { readonly range?: readonly [number, number, number] } | null | undefined)?.range
  return range === undefined ? 1 : counter.linePos(range[0]).line
}

/**
 * Uses an error's prepared source location, or resolves its original offset.
 * @category diagnostics
 * @since 1.0.0
 */
export const parseErrorLine = (counter: Yaml.LineCounter, failure: Yaml.YAMLParseError): number =>
  failure.linePos?.[0].line ?? counter.linePos(failure.pos[0]).line
