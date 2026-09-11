/*
 * The fixture the LSP seam and route tests drive the REAL
 * typescript-language-server against: a project under a temp dir with a
 * tsconfig, two files, one deliberate type error, and the workspace's own
 * `typescript` linked in so tsserver resolves as it does in a checkout.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { ServerLookup } from "./LanguageServers"

export const writeFixtureProject = async (root: string): Promise<void> => {
  const typescriptDir = dirname(createRequire(import.meta.url).resolve("typescript/package.json"))
  await mkdir(join(root, "src"), { recursive: true })
  await mkdir(join(root, "node_modules"), { recursive: true })
  await symlink(typescriptDir, join(root, "node_modules", "typescript"))
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, types: [] },
      include: ["src"]
    })
  )
  await writeFile(
    join(root, "src", "greet.ts"),
    [
      "export interface Greeting {",
      "  readonly name: string",
      "  readonly count: number",
      "}",
      "",
      "export const greet = (greeting: Greeting): string => `hello ${greeting.name} x${greeting.count}`",
      ""
    ].join("\n")
  )
  await writeFile(
    join(root, "src", "index.ts"),
    [
      "import { greet } from \"./greet\"",
      "",
      "const message = greet({ name: \"smithers\", count: 2 })",
      "const length = message.lenght",
      "export { length }",
      "",
      "export const README = \"not code\"",
      ""
    ].join("\n")
  )
  await writeFile(join(root, "README.md"), "# fixture\n")
}

/** A lookup that finds nothing: the missing-server door, with no process spawned. */
export const emptyLookup = (home: string): ServerLookup => ({
  env: { PATH: "" },
  home,
  listDir: () => [],
  isFile: () => false,
  realpath: (path) => path
})
