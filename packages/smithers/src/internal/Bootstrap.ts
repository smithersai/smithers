/** Keep persisted callback fingerprints on the established declaration compiler. */
export const deferTypeScript = (args: ReadonlyArray<string>): boolean =>
  args[0] === "environment" &&
  ["add", "list", "view", "remove"].includes(args[1] ?? "") &&
  !args.some((arg) => /^--(?:mcp|http)(?:=|$)/.test(arg))
