import { vibeDeclarations } from "../../../../eslint.jsdoc.js"
import { packageConfig } from "../../../../eslint.package.js"

// The shared config types and lints `src` only. `examples` get the same rules,
// typed through tsconfig.test.json, which is the project that includes them.
const config = await packageConfig({ tsconfigRootDir: import.meta.dirname, bun: true })

// VibeLang writes these declarations beside each .vibe source; they are generated and untracked.
const vibeSidecars = { ignores: vibeDeclarations(import.meta.dirname) }

export default [
  vibeSidecars,
  ...config.flatMap((entry) =>
    entry.files?.length === 1 && entry.files[0] === "src/**/*.ts"
      ? [entry, {
        ...entry,
        files: ["examples/**/*.ts"],
        languageOptions: {
          ...entry.languageOptions,
          parserOptions: { project: "./tsconfig.test.json", tsconfigRootDir: import.meta.dirname }
        }
      }]
      : [entry]
  )
]
