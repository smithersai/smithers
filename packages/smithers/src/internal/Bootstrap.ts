/**
 * Native-source bootstrap policy for CLI entrypoints.
 * @since 1.0.0
 */

/**
 * Keep persisted callback fingerprints on the established declaration compiler.
 * @category predicates
 * @since 1.0.0
 */
export const deferTypeScript = (args: ReadonlyArray<string>): boolean =>
  args[0] === "environment" &&
  ["add", "list", "view", "remove"].includes(args[1] ?? "") &&
  !args.some((arg) => /^--(?:mcp|http)(?:=|$)/.test(arg))
