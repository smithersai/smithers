import tseslint from "typescript-eslint"
import { jsdocConvention } from "../../eslint.jsdoc.js"

export default tseslint.config({ ignores: ["**/*.d.vibe.ts"] }, { ignores: ["dist/**"] }, {
  files: ["src/**/*.ts"],
  languageOptions: { parser: tseslint.parser }
}, ...jsdocConvention)
