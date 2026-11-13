import js from "@eslint/js"
import importPlugin from "eslint-plugin-import"
import unicorn from "eslint-plugin-unicorn"
import tseslint from "typescript-eslint"
import { ambientAuthority, invariants, swallowedCause, uninstalledSafety } from "../../../../eslint.invariants.js"
import { jsdocConvention, vibeDeclarations } from "../../../../eslint.jsdoc.js"

export default tseslint.config(
  {
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
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: ["./tsconfig.json"]
        }
      }
    },
    plugins: {
      unicorn
    },
    rules: {
      "@typescript-eslint/array-type": ["error", { default: "generic", readonly: "generic" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
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
  },
  {
    // Examples are outside `tsconfig.json`, which builds `src` only, so they
    // type-check against the test project that includes them.
    files: ["examples/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.test.json",
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ["src/Action/Action.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off"
    }
  },
  {
    files: ["src/Action/make.ts"],
    rules: {
      "prefer-const": "off"
    }
  },
  {
    files: ["src/Flow/Flow.ts"],
    rules: {
      "@typescript-eslint/no-empty-object-type": "off"
    }
  },
  {
    files: ["src/DurableDeferred.ts"],
    rules: {
      "@typescript-eslint/no-unnecessary-type-assertion": "off"
    }
  },
  ...jsdocConvention,
  ...invariants(uninstalledSafety, swallowedCause, ambientAuthority)
)
