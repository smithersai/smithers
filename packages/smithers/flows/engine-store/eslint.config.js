import js from "@eslint/js"
import importPlugin from "eslint-plugin-import"
import unicorn from "eslint-plugin-unicorn"
import { relative, sep } from "node:path"
import tseslint from "typescript-eslint"
import {
  ambientAuthority,
  hostPath,
  invariants,
  swallowedCause,
  uninstalledSafety
} from "../../../../eslint.invariants.js"
import { jsdocConvention } from "../../../../eslint.jsdoc.js"

// Keep the remaining defensive exclusions explicit and bounded. An identical
// pragma copied in the same file must consume a second approval and fail.
const approvedCoverageIgnores = {
  "src/PlanScheduler.ts": [
    "v8 ignore next 3 -- verified plans have serializable material, admission resolves every dependency, and successful upstream values already crossed durable serialization; key derivation still exposes its honest failure channel",
    "v8 ignore next 7 -- unreachable while the invariants above hold"
  ],
  "src/internal/ActionPersistence.ts": [
    "v8 ignore next 3 -- A non-proxy Array always has an own data-property uint32 length.",
    "v8 ignore next -- A key returned by Reflect.ownKeys exists on a non-proxy object.",
    "v8 ignore next -- The typeof switch covers every JavaScript value category."
  ]
}
const noNewCoverageIgnores = {
  meta: { type: "problem", schema: [] },
  create(context) {
    return {
      Program() {
        const path = relative(import.meta.dirname, context.filename).split(sep).join("/")
        const remaining = [...(approvedCoverageIgnores[path] ?? [])]
        for (const comment of context.sourceCode.getAllComments()) {
          if (!/\b(?:v8|c8|istanbul)\s+ignore\b/.test(comment.value)) continue
          const index = remaining.indexOf(comment.value.trim())
          if (index >= 0) remaining.splice(index, 1)
          else {
            context.report({
              loc: comment.loc,
              message: "Cover the production branch; new or widened coverage exclusions are forbidden."
            })
          }
        }
      }
    }
  }
}

export default tseslint.config(
  {
    ignores: ["**/dist", "**/build", "**/coverage"]
  },
  js.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    files: ["src/**/*.ts", "examples/**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        // The test project covers src and examples; examples are outside the
        // build project, so the project service would not find them.
        project: "./tsconfig.test.json",
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
      unicorn,
      coverage: { rules: { "no-new-ignores": noNewCoverageIgnores } }
    },
    rules: {
      "coverage/no-new-ignores": "error",
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
  ...jsdocConvention,
  ...invariants(uninstalledSafety, swallowedCause, ambientAuthority, hostPath)
)
