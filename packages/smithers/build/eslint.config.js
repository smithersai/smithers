import js from "@eslint/js"
import importPlugin from "eslint-plugin-import"
import unicorn from "eslint-plugin-unicorn"
import tseslint from "typescript-eslint"
import { ambientAuthority, invariants, swallowedCause, uninstalledSafety } from "../../../eslint.invariants.js"
import { jsdocConvention } from "../../../eslint.jsdoc.js"

export default tseslint.config(
  {
    ignores: ["**/dist", "**/build", "**/coverage", "**/.alchemy"]
  },
  js.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    files: ["**/*.{js,cjs,mjs}"],
    // Config dependencies can expose only package.json exports, without a
    // legacy main field. Use the same exports-aware resolver as TypeScript.
    settings: {
      "import/resolver": {
        typescript: { project: ["./tsconfig.json", "./infra/tsconfig.json"] }
      }
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        Bun: "readonly",
        console: "readonly",
        globalThis: "readonly",
        Headers: "readonly",
        process: "readonly",
        ReadableStream: "readonly",
        Request: "readonly",
        Response: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly"
      }
    }
  },
  {
    files: ["src/**/*.ts", "infra/**/*.ts"],
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
          project: ["./tsconfig.json", "./infra/tsconfig.json"]
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
      "@typescript-eslint/no-empty-object-type": ["error", { allowObjectTypes: "always" }],
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unnecessary-type-constraint": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-useless-empty-export": "error",
      "import/no-duplicates": "error",
      "import/no-empty-named-blocks": "error",
      "import/no-self-import": "error",
      "no-await-in-loop": "off",
      "no-console": "error",
      "no-control-regex": "off",
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
    // The suite is linted too. The shared JSDoc convention and the three
    // repository invariants scope themselves to `src/**` on purpose
    // (eslint.invariants.js says why: an uninstalled service and a discarded
    // failure are what a double is for), so this block adds the ordinary
    // TypeScript rules to `test/**` and nothing else. The suite lives outside
    // the build tsconfig, so it is parsed against the test one.
    files: ["test/**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname
      }
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: ["./tsconfig.test.json"]
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
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "import/no-duplicates": "error",
      "no-await-in-loop": "off",
      "no-console": "error",
      "no-control-regex": "off",
      "no-shadow": "off",
      "no-unused-vars": "off",
      "no-var": "error",
      "unicorn/no-abusive-eslint-disable": "error"
    }
  },
  {
    files: ["infra/**/*.ts", "terraform/modules/cache/service/**/*.{js,cjs,mjs}"],
    rules: {
      // The cache service sanitizes control characters; matching them is the point.
      "no-control-regex": "off",
      "no-console": "off",
      "import/no-unresolved": ["error", { ignore: ["^bun$"] }]
    }
  },
  {
    files: ["terraform/modules/cache/service/test/**/*.{js,cjs,mjs}"],
    rules: {
      "import/no-unresolved": ["error", { ignore: ["^bun$", "^bun:test$"] }]
    }
  },
  ...jsdocConvention,
  ...invariants(uninstalledSafety, swallowedCause, ambientAuthority)
)
