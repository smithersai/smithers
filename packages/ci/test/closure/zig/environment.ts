/**
 * A Zig repository to check the strategy against, when the environment names
 * one. `Repository.test.vibe` is skipped without it.
 */
export const repository: string | undefined = process.env["SMITHERS_CI_ZIG_REPOSITORY"]

/** The files to edit there, one at a time: paths from the repository root, separated by commas. */
export const changed: ReadonlyArray<string> = (process.env["SMITHERS_CI_ZIG_CHANGED"] ?? "")
  .split(",")
  .map((file) => file.trim())
  .filter((file) => file !== "")
