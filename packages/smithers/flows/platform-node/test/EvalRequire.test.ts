/**
 * `@effect/platform-node` 4.1.1 loads `node:http` through `createRequire`, choosing
 * its base with `typeof __filename === "string"`. `node --eval` and `node --print`
 * define a global `__filename` of `[eval]`, so the ESM module passed that string to
 * `createRequire` and threw ERR_INVALID_ARG_VALUE while loading. The release smoke
 * requires every packed package exactly this way, and the platform-node,
 * platform-bun, cli and build-cli tarballs vendor the module, so 1.0.0-rc.17 failed
 * its smoke. patches/@effect__platform-node@4.1.1.patch bases it on
 * `import.meta.url` first (patches/README.md).
 */
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const packageRoot = resolve(import.meta.dirname, "..")

const evaluate = (flag: "--eval" | "--print", source: string) =>
  spawnSync(process.execPath, [flag, source], { cwd: packageRoot, encoding: "utf8", timeout: 30_000 })

describe("@effect/platform-node HTTP modules under node --eval", () => {
  it.each(["NodeHttpClient", "NodeHttpServer", "NodeClusterHttp"])("%s loads through require", (module) => {
    const result = evaluate("--eval", `require(${JSON.stringify(`@effect/platform-node/${module}`)})`)
    expect(result.stderr).not.toContain("ERR_INVALID_ARG_VALUE")
    expect(result.status).toBe(0)
  })

  it("NodeHttpClient loads through --print and exposes its layer", () => {
    const result = evaluate("--print", `typeof require("@effect/platform-node/NodeHttpClient").layerUndici`)
    expect(result.stderr).not.toContain("ERR_INVALID_ARG_VALUE")
    expect(result.stdout.trim()).toBe("object")
    expect(result.status).toBe(0)
  })
})
