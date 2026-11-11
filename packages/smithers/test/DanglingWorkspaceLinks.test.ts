/**
 * The one import failure whose own message names the wrong problem.
 *
 * The 0.x requirements carried forward
 * (`packages/smithers/tests/bin-dangling-workspace-link-hint.test.js` and
 * `dangling-many-links.test.js`): a checkout whose `node_modules/@smthrs/*`
 * links point into a git worktree that has since been removed fails with
 * `ERR_MODULE_NOT_FOUND` for a package that is present in the tree, and the
 * reader goes looking for a build problem that does not exist. The shim says
 * which links are broken, where they pointed, and what repairs them.
 *
 * The rest of the 0.x bin does not survive. `smithers-delegation.js` re-execed
 * into a nearest local `smthrs` install and parsed a JSX workflow path out of
 * argv; rc.0 publishes one package with one bin, takes no workflow-path
 * argument, and `bin/smithers.mjs` selects `dist` or `src` and nothing else.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { spawnNodeSync } from "./support/node-child.ts"
// @ts-expect-error the shim and its helpers are plain ESM, deliberately buildless
import { danglingWorkspaceLinkHint } from "../bin/dangling-workspace-links.mjs"

const staged: Array<string> = []

const root = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-dangling-"))
  staged.push(directory)
  return directory
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

describe("the dangling workspace link diagnosis", () => {
  it("keeps the repair diagnosis when a source bootstrap dependency cannot load", () => {
    const directory = root()
    mkdirSync(join(directory, "bin"), { recursive: true })
    mkdirSync(join(directory, "src", "internal"), { recursive: true })
    mkdirSync(join(directory, "node_modules", "@smthrs"), { recursive: true })
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }))
    for (const name of ["smithers.mjs", "dangling-workspace-links.mjs"]) {
      cpSync(new URL(`../bin/${name}`, import.meta.url), join(directory, "bin", name))
    }
    cpSync(new URL("../src/bin.ts", import.meta.url), join(directory, "src", "bin.ts"))
    cpSync(
      new URL("../src/internal/NodeVersion.ts", import.meta.url),
      join(directory, "src", "internal", "NodeVersion.ts")
    )
    symlinkSync(
      fileURLToPath(new URL("../node_modules/vibelang", import.meta.url)),
      join(directory, "node_modules", "vibelang"),
      "dir"
    )
    symlinkSync(join(directory, "removed", "build-cli"), join(directory, "node_modules", "@smthrs", "build-cli"))
    const result = spawnNodeSync([join(directory, "bin", "smithers.mjs"), "--help"], {
      cwd: directory,
      env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 30_000
    })
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain("dangling workspace link")
    expect(result.stderr).toContain("build-cli")
    expect(result.stderr).toContain("pnpm install")
  })

  it("names the broken scoped link, its dead target, and the repair", () => {
    const directory = root()
    const scope = join(directory, "node_modules", "@smthrs")
    mkdirSync(scope, { recursive: true })
    const removedWorktree = join(directory, ".worktrees", "lane", "packages", "control")
    symlinkSync(removedWorktree, join(scope, "control"))

    const hint = danglingWorkspaceLinkHint(join(directory, "packages", "cli", "bin")) as string | null

    expect(hint).not.toBeNull()
    expect(hint).toContain(join(scope, "control"))
    expect(hint).toContain(removedWorktree)
    expect(hint).toContain("worktree")
    expect(hint).toContain("pnpm install")
  })

  it("reports a broken unscoped link too", () => {
    const directory = root()
    const nodeModules = join(directory, "node_modules")
    mkdirSync(nodeModules, { recursive: true })
    symlinkSync(join(directory, "gone", "packages", "smithers"), join(nodeModules, "smthrs"))

    expect(danglingWorkspaceLinkHint(directory)).toContain(join(nodeModules, "smthrs"))
  })

  it("summarizes the tail when more than five links are broken", () => {
    const directory = root()
    const scope = join(directory, "node_modules", "@smthrs")
    mkdirSync(scope, { recursive: true })
    for (let index = 0; index < 7; index++) {
      symlinkSync(join(directory, "gone", `package-${index}`), join(scope, `package-${index}`))
    }

    const hint = danglingWorkspaceLinkHint(directory) as string

    expect(hint).toContain("7 dangling workspace links")
    expect(hint).toContain("...and 2 more")
  })

  it("says nothing when the links resolve, because the failure is something else", () => {
    const directory = root()
    const scope = join(directory, "node_modules", "@smthrs")
    const target = join(directory, "packages", "control")
    mkdirSync(scope, { recursive: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "package.json"), "{}", "utf8")
    symlinkSync(target, join(scope, "control"))

    expect(danglingWorkspaceLinkHint(directory)).toBeNull()
  })

  it("ignores a real directory that is not a link", () => {
    const directory = root()
    const scope = join(directory, "node_modules", "@smthrs")
    mkdirSync(join(scope, "control"), { recursive: true })

    expect(danglingWorkspaceLinkHint(directory)).toBeNull()
  })
})
