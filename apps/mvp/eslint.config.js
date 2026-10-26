import tseslint from "typescript-eslint"
import { noSharedInflight } from "./eslint.worker-inflight.js"

export default [{
  files: ["worker/**/*.ts"],
  ignores: ["worker/**/*.test.ts", "worker/**/test/**"],
  languageOptions: { parser: tseslint.parser },
  plugins: { worker: { rules: { "request-owned-io": noSharedInflight } } },
  rules: { "worker/request-owned-io": "error" },
}]
