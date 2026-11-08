import { fileURLToPath } from "node:url"

/** The example host's absolute flows directory. */
export const flowsRoot = fileURLToPath(new URL("./flows", import.meta.url))
