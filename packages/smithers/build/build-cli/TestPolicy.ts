/** Existing out-of-scope module replacements, ratcheted until their owning fixes land.
 * No new file or additional replacement is admitted; all other tests use scoped adapters.
 * @since 1.0.0
 */
export const legacyModuleReplacements: Readonly<Record<string, number>> = {}

/** Existing process-platform patches outside the boundary suites; no additions are admitted. */
export const legacyPlatformReplacements: Readonly<Record<string, number>> = {
  "test/WindowsPathResolution.test.ts": 2
}
