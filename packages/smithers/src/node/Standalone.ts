/**
 * Standalone entrypoint for running the `smthrs fleet` CLI directly.
 * @since 1.0.0
 */

import { createNodeCli } from "../commands/Node.ts"

await createNodeCli().serve(process.argv.slice(2))
