#!/usr/bin/env node
/**
 * The `smthrs` executable of the unscoped package, so `npx smthrs <verb>`
 * runs the Smithers CLI. It runs `@smthrs/cli`'s own executable, which picks
 * the built or checkout entry; importing the `smthrs` module still throws.
 */
await import(new URL("bin/smithers.mjs", import.meta.resolve("@smthrs/cli/package.json")).href)
