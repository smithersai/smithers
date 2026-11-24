import js from "@eslint/js"
import importPlugin from "eslint-plugin-import"
import unicorn from "eslint-plugin-unicorn"
import tseslint from "typescript-eslint"
import vibelang from "vibelang/eslint"
import { ambientAuthority, invariants, swallowedCause, uninstalledSafety } from "../../eslint.invariants.js"
import { jsdocConvention, vibeDeclarations } from "../../eslint.jsdoc.js"

/** The rules that read syntax alone, so they hold for TypeScript and VibeLang sources alike. */
const rules = {
  "@typescript-eslint/array-type": ["error", { default: "generic", readonly: "generic" }],
  "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/no-import-type-side-effects": "error",
  "@typescript-eslint/no-unnecessary-type-constraint": "error",
  "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "@typescript-eslint/no-useless-empty-export": "error",
  "import/no-duplicates": "error",
  "import/no-empty-named-blocks": "error",
  "import/no-self-import": "error",
  "no-await-in-loop": "off",
  "no-console": "error",
  "no-fallthrough": "off",
  "no-shadow": "off",
  "no-unneeded-ternary": "error",
  "no-unused-vars": "off",
  "no-useless-concat": "error",
  "no-useless-constructor": "error",
  "no-var": "error",
  "object-shorthand": "off",
  "require-yield": "off",
  "unicorn/no-abusive-eslint-disable": "error",
  "unicorn/no-accessor-recursion": "error",
  "unicorn/prefer-array-flat-map": "error"
}

const settings = {
  "import/resolver": {
    typescript: {
      project: ["./tsconfig.json"]
    }
  }
}

const invariantConfigs = invariants(uninstalledSafety, swallowedCause, ambientAuthority)

export default tseslint.config(
  {
    // VibeLang writes these declarations beside each .vibe source; they are generated and untracked.
    ignores: [
      "**/dist",
      "**/build",
      "**/coverage",
      ...vibeDeclarations(import.meta.dirname)
    ]
  },
  js.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    files: ["src/**/*.ts", "examples/**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    settings,
    plugins: {
      unicorn
    },
    rules: {
      ...rules,
      "@typescript-eslint/no-unnecessary-type-assertion": "error"
    }
  },
  {
    // Most of this package is VibeLang. Its parser gives ESLint the tree typescript-eslint gives for TypeScript, without
    // types: `vibelang --noEmit` checks those, so the one rule above that needs them stays with the TypeScript sources.
    files: ["src/**/*.vibe"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parser: vibelang
    },
    settings,
    plugins: {
      unicorn
    },
    rules
  },
  ...jsdocConvention,
  ...invariantConfigs,
  // The same invariants for the VibeLang sources: eslint.invariants.js names `src/**/*.ts` alone.
  ...invariantConfigs.map((config) => ({
    ...config,
    files: config.files.map((file) => file.replace(/\.ts$/, ".vibe"))
  }))
)
