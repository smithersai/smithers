// Both static-site stacks use the workspace's installed, patched Alchemy CLI and provider.
import { providers, state, Worker } from "@alchemy.run/cloudflare"
export { Stack } from "../../bug-worker/node_modules/alchemy/lib/index.js"
export const Cloudflare = { providers, state, Worker } as const
