import tseslint from "typescript-eslint"
import { failureObserved } from "./eslint.frontend-failures.js"
import { noSharedInflight } from "./eslint.worker-inflight.js"

export default [{
  files: ["worker/**/*.ts"],
  ignores: ["worker/**/*.test.ts", "worker/**/test/**"],
  languageOptions: { parser: tseslint.parser },
  plugins: { worker: { rules: { "request-owned-io": noSharedInflight } } },
  rules: { "worker/request-owned-io": "error" },
}, {
  // Rule obs.frontend-failure-observed (docs/rules.md): every browser failure handler logs or rethrows.
  files: ["src/**/*.{ts,tsx}", "plugins/*/src/**/*.{ts,tsx}"],
  ignores: ["src/**/*.test.ts", "src/test/**", "plugins/**/*.test.ts"],
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
  plugins: { frontend: { rules: { "failure-observed": failureObserved } } },
  rules: { "frontend/failure-observed": "error" },
}]
