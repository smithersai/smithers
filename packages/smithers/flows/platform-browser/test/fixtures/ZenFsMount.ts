/**
 * One real mount for the contract suites, seen the three ways a page composes
 * it: `fs.promises` is the slice `BrowserFileSystem` adapts, `fs` is the
 * synchronous slice jj mounts through WASI, and `bash` is a real just-bash
 * interpreter whose filesystem is {@link justBashFileSystem}, the `IFileSystem`
 * view of that same volume.
 *
 * just-bash takes its own `IFileSystem` rather than a Node-shaped module, so
 * the binding here is the glue a page writes once. Nothing in it stands in for
 * a backend: a command the interpreter runs reads and writes the ZenFS volume
 * itself, which is what lets a split mount, an error code the adapter does not
 * know, or an interpreter option it names wrongly fail in a test.
 */
import { configureSingle, fs, InMemory } from "@zenfs/core"
import { Bash, type FsStat, type IFileSystem } from "just-bash"

/** The ZenFS module: the volume's synchronous API with its promises API attached. */
export type Volume = typeof fs

type Encoding = "utf8" | "utf-8" | "ascii" | "binary" | "base64" | "hex" | "latin1"

const encodingOf = (
  options: { readonly encoding?: Encoding | null | undefined } | Encoding | undefined
): Encoding => (typeof options === "string" ? options : options?.encoding) ?? "utf8"

/** One character per byte, so a byte above 0x7F stays one byte. */
const latin1 = (bytes: Uint8Array): string => Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")

const decode = (bytes: Uint8Array, encoding: Encoding): string => {
  switch (encoding) {
    case "binary":
    case "latin1":
      return latin1(bytes)
    case "base64":
      return btoa(latin1(bytes))
    case "hex":
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    default:
      return new TextDecoder().decode(bytes)
  }
}

const encode = (content: string | Uint8Array, encoding: Encoding): Uint8Array => {
  if (typeof content !== "string") return content
  switch (encoding) {
    case "binary":
    case "latin1":
      return Uint8Array.from(content, (character) => character.charCodeAt(0) & 0xff)
    case "base64":
      return Uint8Array.from(atob(content), (character) => character.charCodeAt(0))
    case "hex":
      return Uint8Array.from(content.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
    default:
      return new TextEncoder().encode(content)
  }
}

/** The members of a ZenFS `Stats` the interpreter's `FsStat` is built from. */
interface VolumeStats {
  readonly isFile: () => boolean
  readonly isDirectory: () => boolean
  readonly isSymbolicLink: () => boolean
  readonly mode: number
  readonly size: number
  readonly mtimeMs: number
  readonly dev: number
  readonly ino: number
}

const statOf = (stats: VolumeStats): FsStat => ({
  isFile: stats.isFile(),
  isDirectory: stats.isDirectory(),
  isSymbolicLink: stats.isSymbolicLink(),
  mode: stats.mode,
  size: stats.size,
  mtime: new Date(stats.mtimeMs),
  dev: stats.dev,
  ino: stats.ino
})

/** POSIX resolution of `path` against `base`, with no process to ask for a working directory. */
const resolvePath = (base: string, path: string): string => {
  const segments: Array<string> = []
  for (const segment of `${path.startsWith("/") ? "" : base}/${path}`.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join("/")}`
}

/**
 * The just-bash view of a ZenFS volume: every `IFileSystem` member, served by
 * the volume's own promises API, and the synchronous `getAllPaths` walk the
 * interpreter's globbing asks for, served by its synchronous API.
 */
export const justBashFileSystem = (volume: Volume): IFileSystem => {
  const promises = volume.promises
  const getAllPaths = (): Array<string> => {
    const found: Array<string> = []
    const walk = (directory: string): void => {
      for (const entry of volume.readdirSync(directory, { withFileTypes: true })) {
        const path = directory === "/" ? `/${entry.name}` : `${directory}/${entry.name}`
        found.push(path)
        if (entry.isDirectory()) walk(path)
      }
    }
    walk("/")
    return found
  }
  return {
    readFile: async (path, options) => decode(new Uint8Array(await promises.readFile(path)), encodingOf(options)),
    readFileBuffer: async (path) => new Uint8Array(await promises.readFile(path)),
    writeFile: (path, content, options) => promises.writeFile(path, encode(content, encodingOf(options))),
    appendFile: (path, content, options) => promises.appendFile(path, encode(content, encodingOf(options))),
    exists: (path) => promises.access(path).then(() => true, () => false),
    stat: async (path) => statOf(await promises.stat(path)),
    lstat: async (path) => statOf(await promises.lstat(path)),
    mkdir: (path, options) => promises.mkdir(path, { recursive: options?.recursive === true }).then(() => undefined),
    createExclusive: (path, options) =>
      options.directory === true
        ? promises.mkdir(path, { mode: options.mode }).then(() => undefined)
        : promises.writeFile(path, new Uint8Array(), { flag: "wx", mode: options.mode }),
    readdir: (path) => promises.readdir(path),
    readdirWithFileTypes: async (path) =>
      (await promises.readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink()
      })),
    rm: (path, options) =>
      promises.rm(path, { recursive: options?.recursive === true, force: options?.force === true }),
    cp: (source, destination, options) => promises.cp(source, destination, { recursive: options?.recursive === true }),
    mv: (source, destination) => promises.rename(source, destination),
    resolvePath,
    getAllPaths,
    chmod: (path, mode) => promises.chmod(path, mode),
    symlink: (target, linkPath) => promises.symlink(target, linkPath),
    link: (existingPath, newPath) => promises.link(existingPath, newPath),
    readlink: (path) => promises.readlink(path),
    realpath: (path) => promises.realpath(path),
    utimes: (path, atime, mtime) => promises.utimes(path, atime, mtime)
  }
}

/** The three views of one mounted volume a page hands `BrowserHost.layer`. */
export interface Mount {
  /** The ZenFS module: `fs` for jj, `fs.promises` for `BrowserFileSystem`. */
  readonly fs: Volume
  /** A real interpreter whose filesystem is the same volume, rooted at `/`. */
  readonly bash: Bash
}

/**
 * Mounts a fresh in-memory ZenFS volume at `/` and binds a just-bash
 * interpreter to it. `env` is the interpreter's own environment, which every
 * command can read unless the caller asks the adapter to replace it.
 *
 * just-bash's defense-in-depth blocks the `Proxy` constructor while a script
 * runs, and ZenFS builds one while it serves the volume, so a page binding
 * ZenFS excludes that one violation type for its trusted filesystem. The
 * rest of the layer stays on: an audit of every command below reported no
 * other type.
 */
export const mount = async (options: { readonly env?: Record<string, string> } = {}): Promise<Mount> => {
  await configureSingle({ backend: InMemory })
  return {
    fs,
    bash: new Bash({
      fs: justBashFileSystem(fs),
      cwd: "/",
      defenseInDepth: { enabled: true, excludeViolationTypes: ["proxy"] },
      ...(options.env === undefined ? {} : { env: options.env })
    })
  }
}
