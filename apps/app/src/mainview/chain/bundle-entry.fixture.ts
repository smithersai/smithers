/*
 * Fixture entry for the browser-bundleability guard in deps.test.ts. Nothing
 * in the app imports this file; Bun.build compiles it from inside the repo so
 * module resolution sees the real node_modules.
 */
import { Chain, QuickJsRunner } from "@smthrs/chain"

export const probe = [typeof Chain.run, typeof QuickJsRunner.layer]
