/** Keep unmeasured CLI children inside the owning test run's scratch/cache scope. */
export const temporaryEnvironment = () => {
  // Vitest disables compile caches in V8 workers. The separate caller-owned
  // reference is only for CLI children, whose coverage is not being collected.
  // Preserve an explicit caller opt-out and any externally requested coverage.
  const measured = process.env.NODE_V8_COVERAGE !== undefined
  const disabled = measured || Boolean(process.env.SMITHERS_CLI_DISABLE_COMPILE_CACHE)
  const cache = disabled ? undefined : process.env.SMITHERS_CLI_NODE_COMPILE_CACHE
  return {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    NODE_COMPILE_CACHE: disabled ? undefined : cache ?? process.env.NODE_COMPILE_CACHE,
    NODE_DISABLE_COMPILE_CACHE: disabled
      ? "1"
      : cache === undefined
      ? process.env.NODE_DISABLE_COMPILE_CACHE
      : undefined,
    NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE,
    VIBELANG_CACHE_DIR: process.env.VIBELANG_CACHE_DIR
  }
}
