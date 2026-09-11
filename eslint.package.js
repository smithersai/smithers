// The conventional package lint config. Shared by every package's
// `eslint.config.js` the same way `eslint.jsdoc.js` is, so a rule change is a
// one-file edit instead of one per package.
//
// Wiring, as a package's whole `eslint.config.js`:
//
//   import { packageConfig } from "../../eslint.package.js"
//
//   export default await packageConfig({ tsconfigRootDir: import.meta.dirname, bun: true })
//
// `tsconfigRootDir` is the package directory the type-aware rules resolve its
// `tsconfig.json` from. `bun` lets the import resolver read `bun:` and Bun
// type imports, for a package that ships a Bun adapter. The plugins resolve
// from that package, which pins their versions in its own devDependencies.

import { createRequire } from "node:module"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { ambientAuthority, invariants, swallowedCause, uninstalledSafety } from "./eslint.invariants.js"
import { jsdocConvention } from "./eslint.jsdoc.js"

export const packageConfig = async ({ tsconfigRootDir, bun = false }) => {
  const packageRequire = createRequire(resolve(tsconfigRootDir, "package.json"))
  const load = async (name) => (await import(pathToFileURL(packageRequire.resolve(name)).href)).default
  const [js, importPlugin, unicorn, tseslint] = await Promise.all(
    ["@eslint/js", "eslint-plugin-import", "eslint-plugin-unicorn", "typescript-eslint"].map(load)
  )
  return tseslint.config(
    {
      ignores: ["**/dist", "**/build", "**/coverage"]
    },
    js.configs.recommended,
    importPlugin.flatConfigs.recommended,
    importPlugin.flatConfigs.typescript,
    {
      files: ["src/**/*.ts"],
      extends: [tseslint.configs.recommended],
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir
        }
      },
      settings: {
        "import/resolver": {
          typescript: bun ? { project: ["./tsconfig.json"], bun: true } : { project: ["./tsconfig.json"] }
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
    ...jsdocConvention,
    ...invariants(uninstalledSafety, swallowedCause, ambientAuthority)
  )
}
