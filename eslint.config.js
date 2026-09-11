import tseslint from "typescript-eslint"
import { jsdocConvention } from "./eslint.jsdoc.js"

// Package source modules inherit the convention by location. Keep this list as explicit opt-outs,
// so a newly added package inherits the public documentation contract.
// UI packages retain their frontend conventions and are outside the rc.0 audit.
const optedOut = ["packages/smithers/ui/**", "packages/ui-core/**", "apps/ui/**"]
const sources = ["packages/*/src/**/*.ts", "packages/*/*/src/**/*.ts", "packages/*/*/*/src/**/*.ts"]

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/template/**", "**/fixtures/**", ...optedOut] },
  // Non-JSDoc directives belong to each package's full lint pass.
  { linterOptions: { reportUnusedDisableDirectives: false } },
  // Operator scripts carry no public-JSDoc contract; they share one statement style.
  { files: ["scripts/**/*.mjs"], rules: { semi: ["error", "never"] } },
  { files: sources, languageOptions: { parser: tseslint.parser }, plugins: { "@typescript-eslint": tseslint.plugin } },
  ...jsdocConvention.map((config) => ({
    ...config,
    files: sources,
    ignores: ["**/*.test.ts"]
  }))
]
