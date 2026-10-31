import { packageConfig } from "../../../../eslint.package.js"

// The shared config types and lints `src` only. `examples` get the same rules,
// typed through tsconfig.test.json, which is the project that includes them.
const config = await packageConfig({ tsconfigRootDir: import.meta.dirname, bun: true })

export default config.flatMap({ ignores: ["**/*.d.vibe.ts"] }, (entry) =>
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
