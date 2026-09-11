import { packageConfig } from "../../../../eslint.package.js"

export default await packageConfig({ tsconfigRootDir: import.meta.dirname, bun: true })
