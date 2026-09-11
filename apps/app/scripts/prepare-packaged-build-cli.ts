import { constants } from "node:fs"
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { resolve, sep } from "node:path"

const uiDirectory = resolve(import.meta.dir, "..")
const rootDirectory = resolve(uiDirectory, "../..")
const runtimeRoot = resolve(uiDirectory, "packaged-runtime")
const destination = resolve(runtimeRoot, "build-cli")

const clean = async (): Promise<void> => {
  if (!destination.startsWith(`${runtimeRoot}${sep}`)) {
    throw new Error(`Refusing to remove unexpected packaged runtime path: ${destination}`)
  }
  await rm(destination, { recursive: true, force: true })
}

const removeBinLinks = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.name === ".bin") {
      await rm(path, { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      await removeBinLinks(path)
    }
  }
}

const symbolicLinks = async (directory: string): Promise<Array<string>> => {
  const found: Array<string> = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) found.push(path)
    else if (entry.isDirectory()) found.push(...await symbolicLinks(path))
  }
  return found
}

const prepare = async (): Promise<void> => {
  await clean()
  await mkdir(runtimeRoot, { recursive: true })
  const child = Bun.spawn([
    "pnpm",
    "--config.inject-workspace-packages=true",
    "--config.node-linker=hoisted",
    "--filter",
    "@smthrs/build-cli",
    "deploy",
    "--prod",
    destination
  ], {
    cwd: rootDirectory,
    env: { ...process.env, CI: "1" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit"
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    await clean()
    throw new Error(`Portable smithers-build deployment failed with exit code ${exitCode}.`)
  }
  // Electrobun's macOS self-extractor installs regular files and directories;
  // pnpm's executable shims are the only links in a hoisted production deploy
  // and are not used by the app's absolute Node launcher.
  await removeBinLinks(resolve(destination, "node_modules"))
  const links = await symbolicLinks(destination)
  if (links.length > 0) {
    await clean()
    throw new Error(`Portable smithers-build runtime still contains symbolic links: ${links.slice(0, 5).join(", ")}`)
  }
  await writeFile(
    resolve(destination, "launcher.mjs"),
    'import "tsx/esm"\n\nawait import("./src/main.js")\n',
    "utf8"
  )
  await Promise.all([
    access(resolve(destination, "src", "main.js"), constants.R_OK),
    access(resolve(destination, "node_modules", "@smthrs", "targets", "package.json"), constants.R_OK),
    access(resolve(destination, "node_modules", "tsx", "dist", "loader.mjs"), constants.R_OK),
    access(resolve(destination, "node_modules", "typescript", "package.json"), constants.R_OK)
  ])
}

if (process.argv.includes("--clean")) await clean()
else await prepare()
