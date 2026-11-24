import tseslint from "typescript-eslint"
import { ambientAuthority, invariants, swallowedCause, uninstalledSafety } from "../../eslint.invariants.js"
import { jsdocConvention, vibeDeclarations } from "../../eslint.jsdoc.js"

export default tseslint.config(
  { ignores: ["dist/**", ...vibeDeclarations(import.meta.dirname)] },
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser }
  },
  ...jsdocConvention,
  ...invariants(uninstalledSafety, swallowedCause, ambientAuthority)
)
