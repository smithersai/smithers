// The platform code of receipts.vibe: durable receipt files on Node's filesystem, fsynced through publication.
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { dirname, join, resolve } from "node:path"

const legacyName = (key: string) => `${createHash("sha256").update(key).digest("hex")}.json`
const receiptName = (key: string) => legacyName(key).replace(/\.json$/, ".receipt.json")
const isReceipt = (name: string) => /^[a-f0-9]{64}(?:\.receipt)?\.json$/.test(name)
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException).code === "ENOENT"

/** A versioned receipt's text decoded, or `undefined` when it is not one. */
export type Decode = (text: string) => { readonly key: string; readonly value: string } | undefined

const receiptValue = (decode: Decode, text: string): string => {
  const decoded = decode(text)
  if (decoded === undefined) throw new Error("Invalid versioned receipt")
  return decoded.value
}

// Distinct filenames make the format unambiguous even when a legacy raw value
// happens to look exactly like the new envelope. Prefer a published new value
// if a crash left its old filename beside it.
const receiptFiles = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const found = new Map<string, string>()
  for (const name of names.filter(isReceipt)) {
    const digest = name.slice(0, 64)
    if (!found.has(digest) || name.endsWith(".receipt.json")) found.set(digest, name)
  }
  return [...found.values()].sort()
}

/** Fsync both file contents and the directory entry that publishes or removes them. */
const syncDirectory = async (directory: string) => {
  const handle = await fs.open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Creates `directory` and fsyncs every directory entry the creation added. */
export const initialize = async (directory: string): Promise<void> => {
  const created = await fs.mkdir(directory, { recursive: true })
  if (created === undefined) return
  const parent = dirname(resolve(created))
  let current = resolve(directory)
  for (;;) {
    await syncDirectory(current)
    if (current === parent) break
    current = dirname(current)
  }
}

/** The value under `key`: its versioned receipt, else its legacy raw file, else `undefined`. */
export const get = async (directory: string, decode: Decode, key: string): Promise<string | undefined> => {
  try {
    return receiptValue(decode, await fs.readFile(join(directory, receiptName(key)), "utf8"))
  } catch (cause) {
    if (!missing(cause)) throw cause
    try {
      return await fs.readFile(join(directory, legacyName(key)), "utf8")
    } catch (legacyCause) {
      if (missing(legacyCause)) return undefined
      throw legacyCause
    }
  }
}

/** Publishes `text` as `key`'s receipt atomically, removing the legacy file, and fsyncs the directory. */
export const set = async (directory: string, key: string, text: string): Promise<void> => {
  const temporary = join(directory, `.${receiptName(key)}.${randomUUID()}.tmp`)
  try {
    const file = await fs.open(temporary, "wx", 0o600)
    try {
      await file.writeFile(text, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    await fs.rename(temporary, join(directory, receiptName(key)))
    await fs.unlink(join(directory, legacyName(key))).catch((cause: unknown) => {
      if (!missing(cause)) throw cause
    })
    await syncDirectory(directory)
  } finally {
    await fs.unlink(temporary).catch((cause: unknown) => {
      if (!missing(cause)) throw cause
    })
  }
}

/** Removes `key`'s receipt and legacy file, when present, and fsyncs the directory. */
export const remove = async (directory: string, key: string): Promise<void> => {
  for (const name of [receiptName(key), legacyName(key)]) {
    await fs.unlink(join(directory, name)).catch((cause: unknown) => {
      if (!missing(cause)) throw cause
    })
  }
  await syncDirectory(directory)
}

/** Removes every receipt file and fsyncs the directory. */
export const clear = async (directory: string): Promise<void> => {
  for (const name of await fs.readdir(directory)) {
    if (isReceipt(name)) await fs.unlink(join(directory, name))
  }
  await syncDirectory(directory)
}

/** Every stored key; a legacy raw file has none to recover. */
export const keys = async (directory: string, decode: Decode): Promise<Array<string>> => {
  const names = receiptFiles(await fs.readdir(directory))
  const keys: Array<string> = []
  for (const name of names) {
    if (!name.endsWith(".receipt.json")) {
      throw new Error("Legacy receipt keys cannot be recovered from hashed filenames")
    }
    const decoded = decode(await fs.readFile(join(directory, name), "utf8"))
    if (decoded === undefined) throw new Error("Legacy receipt keys cannot be recovered from hashed filenames")
    keys.push(decoded.key)
  }
  return keys
}

/** How many receipts the directory holds. */
export const size = async (directory: string): Promise<number> => receiptFiles(await fs.readdir(directory)).length

/** Every stored value, versioned or legacy; a directory that does not exist holds none. */
export const values = async (directory: string, decode: Decode): Promise<Array<string>> => {
  let names: ReadonlyArray<string>
  try {
    names = await fs.readdir(directory)
  } catch (cause) {
    if (missing(cause)) return []
    throw cause
  }
  const values: Array<string> = []
  for (const name of receiptFiles(names)) {
    try {
      const text = await fs.readFile(join(directory, name), "utf8")
      values.push(name.endsWith(".receipt.json") ? receiptValue(decode, text) : text)
    } catch (cause) {
      // Another host can finish and remove a receipt after the listing.
      if (!missing(cause)) throw cause
    }
  }
  return values
}

/**
 * `<repository>/.flows/issue-sweep-jobs`.
 * @throws {never}
 */
export function receiptsDirectory(repository: string): string {
  return join(repository, ".flows", "issue-sweep-jobs")
}
