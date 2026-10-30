/** Keep unmeasured CLI children inside the owning test run's scratch/cache scope. */
export const temporaryEnvironment = (environment: Readonly<Record<string, string | undefined>> = process.env) => {
  // Vitest disables compile caches in V8 workers. The separate caller-owned
  // reference is only for CLI children, whose coverage is not being collected.
  // Preserve an explicit caller opt-out and any externally requested coverage.
  const measured = environment.NODE_V8_COVERAGE !== undefined
  const disabled = measured || Boolean(environment.SMITHERS_CLI_DISABLE_COMPILE_CACHE)
  const cache = disabled ? undefined : environment.SMITHERS_CLI_NODE_COMPILE_CACHE
  return {
    TMPDIR: environment.TMPDIR,
    TMP: environment.TMP,
    TEMP: environment.TEMP,
    NODE_COMPILE_CACHE: disabled ? undefined : cache ?? environment.NODE_COMPILE_CACHE,
    NODE_DISABLE_COMPILE_CACHE: disabled
      ? "1"
      : cache === undefined
      ? environment.NODE_DISABLE_COMPILE_CACHE
      : undefined,
    NODE_V8_COVERAGE: environment.NODE_V8_COVERAGE,
    VIBELANG_CACHE_DIR: environment.VIBELANG_CACHE_DIR
  }
}
