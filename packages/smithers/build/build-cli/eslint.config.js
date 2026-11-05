import js from "@eslint/js"
import importPlugin from "eslint-plugin-import"
import unicorn from "eslint-plugin-unicorn"
import tseslint from "typescript-eslint"
import { ambientAuthority, invariants, swallowedCause, uninstalledSafety } from "../../../../eslint.invariants.js"
import { jsdocConvention } from "../../../../eslint.jsdoc.js"

export default tseslint.config(
  {
    ignores: ["**/dist", "**/build", "**/coverage"]
  },
  js.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        globalThis: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly"
      }
    }
  },
  {
    files: ["src/**/*.ts", "examples/**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        // Lint source and examples in one program without loading the test suite
        // or retaining a second copy of their shared dependency graph.
        projectService: false,
        project: "./tsconfig.lint.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    settings: {
      "import/resolver": {
        // Package metadata may share a subpath name with a TypeScript export, so Node must not bypass package exports.
        node: {
          extensions: [".js", ".jsx", ".mjs", ".cjs"]
        },
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
      "@typescript-eslint/no-empty-object-type": ["error", { allowObjectTypes: "always" }],
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
      "no-control-regex": "off",
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
    files: ["src/**/*.{js,cjs,mjs}"],
    rules: {
      "import/no-unresolved": ["error", { ignore: ["^tsx/cjs/api$", "^tsx/esm/api$", "^@smthrs/targets$"] }]
    }
  },
  ...jsdocConvention,
  {
    files: ["src/**/*.ts"],
    rules: {
      "jsdoc/check-tag-names": ["error", { definedTags: ["category", "since", "slop"] }]
    }
  },
  ...invariants(uninstalledSafety, swallowedCause, ambientAuthority)
)
