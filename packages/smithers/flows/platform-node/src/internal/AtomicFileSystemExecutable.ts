/**
 * Finds the native filesystem helper shipped with this package or built in a
 * source checkout, without accepting an executable from the workspace.
 * @since 1.0.0
 */
import { chmodSync, constants, copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { usableExecutable } from "./AtomicFileSystemTransport.ts"

const moduleDirectory = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url))
const sourcePackageRoot = resolve(moduleDirectory, "../..")

/**
 * The same source module lives one directory deeper after an npm build.
 * @private
 * @since 1.0.0
 */
export const packageRoot = existsSync(join(sourcePackageRoot, "package.json"))
  ? sourcePackageRoot
  : resolve(moduleDirectory, "../../..")

const staged = new Map<string, string>()

/** Pin an install inside the workspace before any flow can modify its bytes. */
const outsideWorkspace = (source: string, boundaryRoot: string | undefined): string => {
  const cached = staged.get(source)
  if (cached !== undefined) return usableExecutable(cached, boundaryRoot)
  for (const base of [tmpdir(), homedir()]) {
    const directory = mkdtempSync(join(base, ".smthrs-atomic-helper-"))
    const destination = join(directory, "smithers-jj-export")
    try {
      chmodSync(directory, 0o700)
      copyFileSync(source, destination, constants.COPYFILE_EXCL)
      chmodSync(destination, 0o500)
      const executable = usableExecutable(destination, boundaryRoot)
      staged.set(source, executable)
      process.once("exit", () => rmSync(directory, { recursive: true, force: true }))
      return executable
    } catch (cause) {
      rmSync(directory, { recursive: true, force: true })
      if (base === homedir()) throw cause
    }
  }
  throw new Error("could not stage smithers-jj-export outside the confined workspace")
}

/**
 * Select only trusted package or checkout locations; never consult PATH or cwd.
 * @private
 * @since 1.0.0
 */
export const resolveDefaultExecutable = (
  root: string,
  boundaryRoot: string | undefined,
  fallback = "/usr/local/bin/smithers-jj-export"
): string => {
  const candidates = [join(root, "bin", `${process.platform}-${process.arch}`, "smithers-jj-export")]
  const checkout = resolve(root, "../../../..")
  if (existsSync(join(checkout, "pnpm-workspace.yaml"))) {
    candidates.push(join(checkout, "target/release/smithers-jj-export"))
    candidates.push(join(checkout, "target/debug/smithers-jj-export"))
  }
  candidates.push(fallback)
  for (const [index, candidate] of candidates.entries()) {
    if (!existsSync(candidate)) continue
    if (index === 0) {
      if (!statSync(candidate).isFile()) throw new Error(`packaged atomic helper is not a regular file: ${candidate}`)
      // npm/pnpm tarballs may store package files without executable bits.
      return outsideWorkspace(candidate, boundaryRoot)
    }
    const executable = usableExecutable(candidate, undefined)
    try {
      return usableExecutable(executable, boundaryRoot)
    } catch (cause) {
      if (
        index === candidates.length - 1 || !(cause instanceof Error) ||
        !cause.message.includes("outside the confined workspace")
      ) throw cause
      return outsideWorkspace(executable, boundaryRoot)
    }
  }
  throw new Error(
    `smithers-jj-export is missing; install @smthrs/platform-node with its native helper, ` +
      `run cargo build --release -p smithers-ffi --bin smithers-jj-export in a source checkout, ` +
      `or set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to its absolute path (searched ${candidates.join(", ")})`
  )
}
