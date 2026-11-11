// The platform code of github.vibe: where the GitHub proxy tool lives on disk, resolved from this module's URL.
import { fileURLToPath } from "node:url"

// The copy beside this flow, like the claim tool.
export const proxyTool = fileURLToPath(new URL("../issue-claim/github-proxy.mjs", import.meta.url))
