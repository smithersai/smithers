import { parser } from "typescript-eslint"
import { jsdocConvention } from "../../../../eslint.jsdoc.js"

const files = ["worker/**/*.ts", "scripts/**/*.ts", "deployment.ts", "alchemy.run.ts"]
export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "worker/test/**", "**/*.test.ts"] },
  { files, languageOptions: { parser } },
  ...jsdocConvention.map((config) => ({ ...config, files }))
]
