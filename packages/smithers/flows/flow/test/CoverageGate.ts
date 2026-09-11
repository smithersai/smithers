/**
 * Whether a Vitest invocation selects the whole suite.
 *
 * Vitest 4 reports every `coverage.include` file whether or not a test loaded
 * it, so a run narrowed by a file filter (`vitest test/Poll.test.ts`), a name
 * pattern (`-t <name>`), `--changed`, or `--related` always ends under the
 * 100% thresholds in `vitest.config.ts` with every executed test passing. The
 * config therefore computes coverage only when nothing narrows the run. An
 * explicit `--coverage` still wins: CLI options override the config.
 */
export const coversWholeSuite = (selection: {
  readonly filter: ReadonlyArray<string>
  readonly options: {
    readonly testNamePattern?: string | RegExp | undefined
    readonly changed?: boolean | string | undefined
    readonly related?: string | ReadonlyArray<string> | undefined
  }
}): boolean =>
  selection.filter.length === 0
  && selection.options.testNamePattern === undefined
  && !selection.options.changed
  && selection.options.related === undefined
